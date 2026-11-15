# Synara backend research and Gyro reliability priorities

Research date: 13 November 2026. Recommendation: keep Gyro's Rust/Tauri architecture and adopt selected durability, scheduling, and lifecycle patterns. The source does not establish that Synara is faster or more reliable overall.

**Scope and evidence**

Synara: official repository `Emanuele-web04/synara`, pinned to commit [`95671f5052d482b28b5217f852f001dca0815d8a`](https://github.com/Emanuele-web04/synara/commit/95671f5052d482b28b5217f852f001dca0815d8a). Its server and desktop manifests identify version 1.5.3. Source was inspected in a separate sparse checkout at `/tmp/gyro-synara-research-2026-11-13`; no Synara application or dependency install was run.

Gyro: `/Users/wytze/Gyro`, branch `v0.1.4`. Initial HEAD was `75eef89a19889afbf3213acd9e7a9b7f0e05598e`; concurrent UI work moved HEAD to `9b1259d7bf30624046c2063d3ec6f2475bdc039c`. The inspected core and desktop Rust source trees were unchanged between those commits. The package manifests still identify 0.1.3; the branch name is not a release claim.

This review covers the local backend: chat persistence, provider execution, event transport, Git work, SQLite, startup and recovery. Hosted Cloud infrastructure, billing, full provider compatibility, native UI acceptance, and comparative production benchmarks were outside this review. Product source was not edited.

**What Synara actually does**

Synara runs a TypeScript/Effect backend separately from its Electron shell. The useful architecture is a chain of explicit state transitions:

1. Provider adapters normalize native runtime events.
2. `ProviderService` correlates those events to session ownership, persists accepted events, then publishes them.
3. Runtime ingestion consumes a journal with durable cursors and reconstructs conversation state.
4. The orchestration engine commits command receipts, domain events, and relevant projections in one SQLite transaction, then publishes committed events.
5. Subscribers receive snapshots and replay from a sequence cursor when reconnecting.

Sources: [provider event persistence and publication][S1], [runtime event journal][S2], [orchestration transaction][S3], [snapshot and replay transport][S4]. These are code paths, not guarantees about every failure mode. The journal has retention and event-size limits.

The desktop supervisor separately distinguishes successful process spawn from backend readiness, backs off failed starts, and stops after five consecutive startup failures. Provider lifecycle operations have per-thread serialization and generation identities. These are useful patterns if Gyro introduces longer-lived backend services; they do not justify a new process boundary by themselves. [Supervisor][S5], [provider lifecycle coordinator][S6].

**What Gyro already has**

Several generic recommendations would repeat existing work:

| Concern | Existing Gyro implementation |
| --- | --- |
| Durable completed messages | JSONL append locks, partial-tail repair, `sync_data`, and turn-message deduplication in [sessions.rs][G1]. The index failure gap below is separate. |
| Process output and cleanup | Bounded channels/output, cancellation polling, process-group cleanup, and timeout handling in [execution.rs][G2]; a bounded Codex protocol reader in [codex_client.rs][G3]. |
| Turn ownership | Four concurrent desktop provider runs, one active reservation per session, ownership-checked release, and finalization in [provider_run_cleanup.rs][G4]. Cross-process session leases and startup reconciliation are in [session_lifecycle.rs][G5]. |
| Provider retries | Account/model cooldown coordination and staggered release already exist in [provider_cooldown.rs][G6]. |
| Database efficiency | WAL, busy handling, connection reuse, and schema-stamp caching already exist in [sqlite.rs][G7]. |
| Git reads | Shared deadlines, disabled optional index writes, cached detail results, and shared concurrent branch reads already exist in [read.rs][G8], [status_cache.rs][G9], and [branches.rs][G10]. |
| Measurement | Opt-in local stage timing already separates process startup, protocol readiness, prompt submission, first activity, first token, and completion in [timing.rs][G11]. |

The opportunities are to close specific gaps and extend these mechanisms.

**Prioritized changes**

| Order | Change | Evidence level | Expected benefit | Scope |
| --- | --- | --- | --- | --- |
| 1 | Make message/status indexes recoverable from their durable log | Reproduced in a disposable database | Prevent duplicate log messages and stale run state after partial persistence failures | Focused storage correction |
| 2 | Reject unsupported future schemas and add migration recovery snapshots | Future-version acceptance reproduced; backup gap inspected | Safer upgrades, downgrades, and recovery | Guard first; backup/restore next |
| 3 | Persist recoverable in-progress assistant output | Code-established persistence gap | Preserve useful partial output across backend crashes and renderer reloads | Incremental journal/checkpoint work |
| 4 | Add bounded Git admission and share concurrent status reads | Code-established scheduling difference; benefit unmeasured | Reduce process bursts and latency under concurrent work | Extend existing Git service |
| 5 | Give SQLite contention and connection memory explicit aggregate budgets | Code-established limits; impact unmeasured | Bound stalls and avoid multiplying cache budgets | Instrument, then tune |
| 6 | Prototype a bounded warm Codex runtime | Code-established lifecycle difference; benefit unmeasured | Avoid repeated local startup/initialization on follow-up turns | Optional measured experiment |

**1. Repair the gap between JSONL durability and SQLite authority**

Gyro correctly treats an fsynced JSONL event as saved even when its SQLite index update fails. Returning a generic failure after a durable append could itself trigger a duplicate retry. However, the next lookup does not consistently repair the index:

- `append_event_with_turn_id` logs failures from `record_turn_message_index` and `record_turn_provider_status`, then returns success.
- `find_indexed_turn_message` assumes that if a session has any indexed turn message, an absent row means no matching message exists. It skips the log lookup in that case.
- `latest_provider_status_for_turn`, `has_running_provider_turn`, and `list_running_turns` read the status table without checking how far it reflects the log.

Sources: [durable append and best-effort index updates][G1], [message-index authority assumption][G12], [status-index reads][G13]. An existing test explicitly verifies successful durable append despite status-index failure, but it does not verify subsequent repair.

A transient index failure after an earlier indexed message can therefore allow the same turn/message to be appended twice. A failed final status-index write can leave the log saying `done` while the index still says `running`. Startup reconciliation consults that index, so stale entries can also produce misleading interruption recovery. The duplicate/stale-index behaviors are directly testable without invoking a provider; the startup consequence follows from [the reconciliation code][G5]. It is not evidence that tools were executed twice.

Recommended correction: keep JSONL as the durable source and track a committed per-session indexing offset plus log identity. Catch up message and status projections before using them for deduplication or lifecycle decisions. Update the projections and watermark in one SQLite transaction; preserve the watermark on failure. Handle truncation/replacement and coordinate with the existing append lock. Gyro's context index already offers a useful incremental-offset pattern in [sessions.rs][G14]. Do not replace this with a full log scan on every request.

Synara's relevant lesson is its atomic event/projection/receipt boundary and cursor-based recovery, not a mandatory event-sourcing rewrite. Later, add a distinct command ID and request fingerprint where RPC delivery can be ambiguous. A command identity must be separate from a turn ID because deliberate retries can create new attempts within one turn. Synara's [fingerprint validation and receipt handling][S7] is a concrete reference. No receipt can promise exactly-once execution of arbitrary external tools after a process dies between dispatch and acknowledgement.

Acceptance: inject an index failure after JSONL fsync; retry the message and observe one durable event. Inject failure while saving `done`; reopen and observe `done` from every lifecycle query. Repeat across two processes and kill between append/index commits. Verify large histories require only tail catch-up.

**2. Protect schema compatibility and upgrades**

Gyro currently accepts `user_version >= SESSION_STORE_SCHEMA_VERSION` and calls `ensure_current_schema`. A database marked newer than this binary therefore enters writable schema maintenance. The current version constant is 16. This is a missing forward-version fence, not proof that current migrations corrupt data. [Initialization code][G15].

Synara explicitly rejects a known migration lineage followed by newer unsupported migrations. Its startup path wraps migrations in a snapshot/recovery workflow, takes a consistent SQLite snapshot with `VACUUM INTO`, and distinguishes interrupted migration recovery from a new attempt. [Schema fence][S8], [startup migration wiring][S9], [backup creation][S10].

First add a `>` rejection before schema maintenance, with a clear supported/found version error. Then add a consistent pre-migration backup and a tested restore path, including retention and disk-space handling. Preserve the relation between restored SQLite metadata and JSONL history. Reuse an existing recovery snapshot after interrupted migration rather than creating one per failed start.

Gyro already serializes older-schema migration with an immediate transaction. Keep that. Synara's lifetime exclusive database lock is unsuitable to copy directly because Gyro intentionally supports desktop and CLI connections to the same database.

Acceptance: a future schema is rejected before schema changes; supported older schemas migrate; two openers coordinate; a killed migration can restore a verified snapshot; a full disk leaves the original usable.

**3. Preserve in-progress output and make reconnects replayable**

Gyro's stream emitter constructs a frame and sends it through Tauri; its sequence is run-local memory. The complete assistant response is appended after the runner returns. The desktop limit file also explicitly describes finished-message-only persistence. Existing tool/mutation records and efficiency checkpoints cover some work, but they do not constitute a journal of every live assistant response. [Emitter][G16], [final assistant append][G17], [live-output contract][G18].

Consequently, a hard backend exit before final response persistence can lose text already displayed to the user. A reload during a turn cannot recover missing live text from a durable assistant-stream cursor. This is a source-established recovery gap; no installed-app crash experiment was performed.

Synara persists accepted runtime events before publication and lets consumers resume by sequence. Its callback ingress has count/byte budgets and reserves capacity for terminal events. [Journal publication][S1], [bounded ingress][S11], [replay][S4].

For Gyro, start with coalesced partial-response checkpoints carrying session, turn, attempt, stream revision, and text/segment state. A candidate interval is 250–500 ms plus tool/terminal boundaries, subject to measurement. Clearly distinguish live display from confirmed durable progress. Finalize idempotently and expose recovery by revision. Add a full event journal only where replay requires finer detail. Preserve the existing completed-message fsync guarantee; do not fsync every token.

Acceptance: kill a fake-provider host after known output boundaries, reopen, and verify the defined loss window; reload a renderer mid-turn; replay duplicate/late frames; verify one final message and no duplicate tool action. Flood output and ensure cancellation and terminal settlement remain responsive.

**4. Control Git work across callers**

Gyro has effective per-operation bounds, branch-read sharing, and detail caching. However, the inspected desktop Git entry points independently enter `spawn_blocking`; status runs `git status` before consulting its detail cache. I found no shared Git admission mechanism on those paths. Existing frontend coalescing and provider-run limits do not create a backend-wide Git budget. [Command entry points][G19], [status read and cache order][G9].

Synara has FIFO admission classes with separate permits for ordinary reads, checkpoints, and long/network commands, bounded waiting queues, cancellation-safe ticket release, and reserved foreground capacity against opportunistic background network work. Its concurrency tests exercise blocked long work, cancelled waiters, and overflow. [Admission implementation][S12], [tests][S13].

Extend Gyro's existing Git service with shared in-flight status reads keyed by worktree and read shape. Add bounded foreground/background admission; count queue time in the caller's existing deadline and remove cancelled tickets. Serialize conflicting mutations by common Git directory while preserving worktree-specific read results. Start with measured low concurrency; Synara's exact permit counts are not requirements for Gyro.

Acceptance: simultaneous sidebar, Source Control, and agent requests share compatible reads; slow fetches do not consume all read capacity; queue overflow is explicit; cancelled work never spawns; mutations invalidate stale reads. Measure p95 latency and peak child count in a large disposable repository.

**5. Budget SQLite across connections and requests**

Gyro configures a 10-second busy timeout and a retry helper with eight retries after the initial attempt. The helper has no operation deadline or cancellation input. If each attempted operation consumes its full SQLite wait, a wrapped operation can approach 90 seconds plus backoff; this is a conditional upper-bound calculation, not an observed 90-second hang. Some errors return immediately, and many statements do not use this retry helper. [Busy settings and retry code][G7].

Each connection also receives a 64 MiB page-cache ceiling. The pool retains up to eight idle connections for one database, but does not cap active connections. Eight heavily used connections could retain up to roughly 512 MiB of configured page-cache capacity, before active connections and other stores. These are ceilings, not measurements or eager allocations; mmap windows are not equivalent to private RSS.

Add per-operation deadlines/cancellation to contention handling, keeping background maintenance out of interactive request budgets. Measure active/idle connection counts, busy duration, cache use, and RSS before changing limits. Consider a bounded write service and a bounded read pool with an aggregate memory budget. Preserve cross-process desktop/CLI behavior. Synara's [single-connection setup][S9] and [memory-budget helper][S14] are useful comparisons, not drop-in settings.

Acceptance: deliberately hold a write lock, cancel a waiting request, and verify a prompt return; run four chats plus history reads and maintenance; verify bounded connection counts and no sustained memory growth. Protect durable writes from accidental replay of non-idempotent transaction fragments.

**6. Test warm Codex sessions as a speed experiment**

Gyro's Codex runner spawns an app-server, initializes it, starts/resumes a thread, runs a turn, and drops the client at the end. Follow-up turns repeat that local startup. [Runner lifecycle][G20]. Synara retains session contexts in a manager; `sendTurn` obtains an existing context, with explicit lifecycle ownership and idle reaping elsewhere. [Codex manager][S15], [idle reaper][S16].

Prototype a small, optional per-chat pool. Reuse only when account, executable/version, workspace identity, permissions, and MCP capability context remain compatible. Rebind per-turn authority and attach a generation so an old process cannot settle a replacement run. Close idle processes, evict on memory pressure, and retain the cold-start fallback. Process liveness alone is not readiness.

Measure local startup and protocol time separately from provider/network first-token time with Gyro's existing timing stages. Keep the experiment only if repeat-turn latency improves enough to justify idle memory and lifecycle complexity. Do not broaden to other providers until their runtime contracts are separately verified.

Acceptance: cold/warm paired runs, process death between turns, account changes, workspace changes, cancellation, stale callbacks, and idle eviction. Record p50/p95 startup, first-token time, RSS, and process count. No speedup percentage has been established by this research.

**Validation and implementation sequence**

The [disposable probe source](/Users/wytze/Gyro/docs/research/synara-backend-2026-11-13/probe.rs) called the actual `gyro-core` crate using a temporary database. It confirmed all three assertions:

```text
message_index_failure: append_returned_ok=true duplicate_event_ids=true durable_copies=2
status_index_failure_after_reopen: log_status="done" index_status=Some("running") has_running=true
future_schema: user_version=9999 open_accepted=true
```

The existing core test for preserving a durable append despite status-index failure passed. The existing provider stream-ordering checks also passed for 42 catalog/custom model fixtures. These are normalized-event checks, not live-provider acceptance. Synara tests were read for behavioral intent but were not executed. Commands, output, and limits are in [validation.txt](/Users/wytze/Gyro/docs/research/synara-backend-2026-11-13/validation.txt).

To reproduce the additional probe, create a disposable Cargo package, use [the recorded manifest](/Users/wytze/Gyro/docs/research/synara-backend-2026-11-13/probe-Cargo.toml) as `Cargo.toml`, and copy `probe.rs` to `src/main.rs`. Adjust the Gyro path if needed, copy the workspace `Cargo.lock`, and run `cargo run --offline --manifest-path <temporary-directory>/Cargo.toml`. Its assertions intentionally confirm the defects; revise them when implementing fixes.

Implement index recovery and the schema fence first. Add backup/restore and partial-output recovery next. Establish a contention/concurrency baseline, then add Git admission and tune SQLite budgets. Evaluate warm Codex sessions last, behind an option, because they add lifecycle state while the first changes improve correctness directly.

Proposed release gates: no duplicate durable message after failure injection; no false running status after reconciliation; an explicit partial-output recovery window; bounded Git/database queues; cancellation remains responsive under output/storage pressure; no steady memory growth in repeated-turn tests. Numerical latency and memory targets should be set from the baseline, not invented here.

Synara also has costs and incomplete patterns: its Git status broadcaster still creates an unbounded pub/sub, and provider/orchestration/migration code is substantial. [Broadcaster][S17]. Copy the specific invariants that solve demonstrated Gyro problems. Preserve Gyro's existing provider boundary, process supervision, and stronger explicit JSONL fsync contract; Synara's SQLite `NORMAL` policy explicitly accepts possible loss of recent commits after power/OS failure. [SQLite policy][S9].

[G1]: /Users/wytze/Gyro/crates/gyro-core/src/sessions.rs:1484
[G2]: /Users/wytze/Gyro/crates/gyro-core/src/execution.rs:339
[G3]: /Users/wytze/Gyro/crates/gyro-core/src/provider_runtime/codex_client.rs:80
[G4]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/provider_run_cleanup.rs:22
[G5]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/providers/session_lifecycle.rs:115
[G6]: /Users/wytze/Gyro/crates/gyro-core/src/provider_cooldown.rs:177
[G7]: /Users/wytze/Gyro/crates/gyro-core/src/sqlite.rs:16
[G8]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/git/read.rs:12
[G9]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/git/status_cache.rs:247
[G10]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/git/branches.rs:64
[G11]: /Users/wytze/Gyro/crates/gyro-core/src/timing.rs:21
[G12]: /Users/wytze/Gyro/crates/gyro-core/src/sessions.rs:2418
[G13]: /Users/wytze/Gyro/crates/gyro-core/src/sessions.rs:1584
[G14]: /Users/wytze/Gyro/crates/gyro-core/src/sessions.rs:2023
[G15]: /Users/wytze/Gyro/crates/gyro-core/src/sessions.rs:2203
[G16]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/providers/events.rs:434
[G17]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/providers/run.rs:570
[G18]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/app/limits.rs:12
[G19]: /Users/wytze/Gyro/apps/desktop/src-tauri/src/git/commands.rs:30
[G20]: /Users/wytze/Gyro/crates/gyro-core/src/provider_runtime/runners/codex.rs:301
[S1]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/provider/Layers/ProviderService.ts#L2229-L2254
[S2]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/persistence/Layers/ProviderRuntimeEvents.ts#L143
[S3]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L1294-L1412
[S4]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/wsRpc.ts#L1770-L1908
[S5]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/desktop/src/backendSupervisionPolicy.ts#L7-L124
[S6]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/provider/providerLifecycleCoordinator.ts#L8-L140
[S7]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L335-L355
[S8]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/persistence/Migrations.ts#L633-L654
[S9]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/persistence/Layers/Sqlite.ts#L87-L160
[S10]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/persistence/MigrationBackup.ts#L819-L880
[S11]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/provider/boundedCallbackIngress.ts#L1-L96
[S12]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/git/Layers/GitCommandAdmission.ts#L6
[S13]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/git/Layers/GitCore.concurrency.test.ts#L372
[S14]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/persistence/sqliteMemoryBudget.ts#L18-L33
[S15]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/codexAppServerManager.ts#L1704-L1734
[S16]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/provider/Layers/ProviderSessionReaper.ts#L10-L94
[S17]: https://github.com/Emanuele-web04/synara/blob/95671f5052d482b28b5217f852f001dca0815d8a/apps/server/src/git/Layers/GitStatusBroadcaster.ts#L44-L52
