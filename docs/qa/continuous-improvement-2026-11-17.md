# Continuous improvement — 17 November 2026

Completed the requested four-hour work period: **07:53:29–11:53:29 UTC / 08:53:29–12:53:29 Amsterdam**. Fourteen loops prioritized bugs, backend speed/security/reliability, then optimization. Closing checks and artifact finalization followed the deadline.

The checkout began with substantial unrelated changes. Starting status, tracked patch, reconstructed baseline copies for this pass's edited tracked files, test logs, and focused diffs live in the private directory `/tmp/gyro-four-hour-20261117`. Existing work remains uncommitted. No commit, push, installation, release, or deployment is authorized by this task.

## Loop 1 — verified by 08:16 UTC

### Fixed behavior

- **Stale Git statistics:** same-size file rewrites or atomic replacements with restored mtime could reuse the entire old status before the line-count cache revalidated the file. The status stamp now includes Unix identity, nanosecond change time and mode. A disposable-repository regression failed before and passed after the change.
- **Permanently cached Git detail failures:** incomplete statistics/history/comparison snapshots remain available as timeout fallback, but cannot be accepted as complete cache hits. The regression failed before and passed after the change.
- **Blocked editor draft recovery could not retry:** a blocked IndexedDB open left a permanently rejected cached promise. Failed/blocked opens now invalidate only their own cache entry; late successful opens close their abandoned connection; version changes and unexpected connection closures retire the cached connection. Controlled lifecycle regression failed before and passed after. Real IndexedDB still preserves a 2 MiB conflicted draft across reload and clears it without resurrection.
- **Embedded startup ownership:** durable workspace recovery is imported only in the main-window boot path. Embedded pages and the menu-bar path do not load this workspace module. Existing embedded-boundary behavioral checks pass.

### Maintenance and verification repairs

- Extracted the capability-event subscription from `App.tsx` into `use-provider-capability-events.ts`, keeping its original effect semantics and stable-ref behavior. This returns App below the existing architecture ceiling; no ceiling was raised. The extracted effect's printed AST matches the starting checkout exactly.
- Updated startup/page fixtures for configuration recovery and draft-storage startup failure; updated the workspace evidence fixture to retain `useRef` values; updated the terminal source guard to recognize the stronger running/waiting-only input gate.
- Added package runners for the existing chat-session and terminal-renderer browser guards and classified all eight previously unregistered guards. Registry verifies 197 reachable guards.
- Recovery-browser profile cleanup now retries transient Chromium filesystem cleanup races.
- Corrected the live-event buffer comment: event producers own redaction; the buffer itself bounds and compacts payloads. No runtime behavior changed in that file.

### Evidence

- `CARGO_INCREMENTAL=0 cargo test --locked --workspace -- --test-threads=4`: **2,370 passed, 21 ignored, zero failed** across 17 test/doc-test suites. `rust-workspace.log`.
- Focused desktop Git suite: **53 passed, one ignored**. `git-cache-before.log` records both new failures; `git-cache-after.log` records passing fixes.
- Complete `pnpm test:reliability`: passed, including the new IndexedDB regression. `reliability-cycle1-with-idb.log`.
- Desktop TypeScript check passed using the installed compiler. `typecheck-cycle1-final.log`.
- Chat browser checks passed for retry focus/pending state, content fidelity and interrupted labels in light/dark at 390/1280 px. `chat-session-browser.log`.
- Terminal browser checks passed for geometry, notice, reveal, restart, typing, Ctrl-C, focus and stopped input. `terminal-renderer-browser.log`.
- Real IndexedDB recovery browser checks passed. `workspace-recovery-after-idb.log`.
- Changed module/check-script formatting and `git diff --check` passed.

The pnpm wrapper attempts an unrelated reinstall unless `pnpm_config_verify_deps_before_run=false` is set. Use that environment override for subsequent pnpm verification. Tests need localhost/subprocess permissions. Rust compilation should use `CARGO_INCREMENTAL=0`: disk was nearly full; after confirming no compiler was active, only ignored regenerable `target/debug/incremental` was removed, restoring roughly 2 GiB of usable space.

### Scoped security review

Completed a Standard source scan of all **12 files under `crates/gyro-remote`**, with an independent baseline, architecture review and focused event-boundary investigation. **No confirmed vulnerability found in this scope.** This is not a whole-app security or deployment claim.

Scan `4dc77296-7a98-4b5c-857b-5459de241e30`; report:
`/Users/wytze/.codex/state/plugins/codex-security/scans/Gyro/143dc90d7548728d7deda704c2bd1a5f505c39cf_20261117T075650Z_t7os2taf/report.md`.

The scan describes its starting snapshot; unrelated App/Git edits occurred while it ran. In-scope code was unchanged during review; the buffer-comment correction happened afterward. Tool-reported usage was 10,785,482 total tokens across four owning threads, including 10,359,552 cached input tokens; this is rollout-based accounting rather than a separately measured marginal scan cost.

Retained follow-ups: durable receipt/submitted-turn growth, intentional survival of admitted Iroh handlers after disconnection, client Watch response/session validation, and upstream payload handling. No exploit was established for these observations. Remote terminals intentionally run with host-user OS authority; shared project APIs are not an OS sandbox. Root SECURITY.md has a stale macOS plaintext-key description; current code uses Keychain migration/storage.

## Loop 2 — configuration and remote storage

- Reproduced overlapping configuration refreshes rolling newer preferences back to an older response. Added refresh generations that suppress outdated successes, failures, capability manifests and optional Ollama discovery. The controlled regression failed before and passed after; it also verifies stale errors cannot reopen recovery and late discovery cannot replace the newest catalog. `config-race-before.log`, `config-race-after.log`.
- Full reliability chain passed again after the configuration change. TypeScript passed. `reliability-config-race.log`, `typecheck-config-race.log`.
- Reproduced an abandoned remote IndexedDB open retaining its late successful connection. Remote storage now retires abandoned opens, forgets only its own cached connection, and permits recovery after unexpected connection closure. Controlled lifecycle tests passed after the fix. Real-browser remote storage migration/reload/isolation/deletion verification passed. `remote-idb-before.log`, `remote-idb-after.log`, `remote-storage-browser.log`, `typecheck-remote-idb.log`.
- Existing read-only branch benchmark on this checkout: 15 interleaved trials, median previous three-command discovery **41.4 ms**, shared discovery **17.0 ms**, agent discovery **17.7 ms**. This measures existing code paths, not an improvement introduced by this task. `git-branch-baseline.log`.

## Loop 2 checkpoint plan

The following work continued in the later loops below.

1. Profile concurrent backend Git/status reads and decide whether bounded detail-read admission avoids redundant subprocesses while retaining fresh status and deadlines.
2. Review remote storage hydration/write interleavings and database-reopen cache validity; preserve existing deletion and host-isolation guarantees.
3. Continue broader backend/provider and workspace bug discovery. Preserve receipt/lease/approval semantics and use measurements for speed claims.

Browser evidence is fixture evidence. No live paid-provider run, installed-app upgrade, physical two-Mac/WAN test, or hardware sleep/wake acceptance has been performed.

## Loop 3 — remote consistency and measured Git work

- Reproduced late remote hydration replacing newer in-memory drafts and pending-submit metadata. Hydration now reads the current view after its IndexedDB read; recovered buffers merge with current edits. Controlled regression failed before and passed after. `hydration-before.log`, `hydration-after.log`.
- Real Chromium reproduction showed that replacing the draft database could make unchanged live buffers falsely appear persisted, losing them on reload. Persistence caches now belong to their database connection; replacement/closure invalidates them, and old transactions cannot repopulate a newer connection's cache. A write with an unknown baseline reads stored keys before deleting absent entries. Real-browser tests verify unchanged-draft re-save after replacement and deletion before hydration. `storage-reopen-before.log`, `storage-reopen-after.log`; TypeScript and remote client regressions passed.
- Added per-workspace Git detail admission with deadline-aware waits and automatic release. Each caller still reads porcelain status; concurrent callers recheck the detailed cache after admission instead of repeating statistics/history subprocesses. Waiting for one workspace does not block another. Timeout returns fresh paths with explicitly incomplete statistics. A panicking reader releases the gate.
- Same disposable 101-file workload, five trials per concurrency level: eight readers fell from **56 to 14 Git subprocesses**, with median batch completion **181.0 to 105.4 ms** (about 42% lower). One reader remained **86.4 vs 85.9 ms**, seven subprocesses. This is a local controlled benchmark, not a WAN/UI/provider speed claim. Reproduce with `cargo test --locked -p gyro-desktop --lib git::status_cache::tests::benchmark_concurrent_status_reads -- --ignored --exact --nocapture`; run that tracing benchmark alone. Logs: `git-status-concurrency-before.log`, `git-status-concurrency-after.log`.
- Final focused Git suite: **56 passed, two ignored**. Desktop backend suite: **1,089 passed, 13 ignored**. Architecture and command-blocking checks passed. `git-admission-final.log`, `desktop-after-admission.log`.

## Loop 4 — attachment consumers

- Four disposable-image regressions failed before the change: OpenAI-compatible and Claude payload builders accepted oversized images and same-size files whose bytes no longer matched the attachment hash. All four pass afterward, together with a positive test preserving verified image bytes and prompt text. `attachment-payloads-before.log`, `attachment-payloads-after.log`.
- OpenAI-compatible, Claude, Ollama and ACP image consumers now use one bounded regular-file reader. ACP workspace text uses its existing 32 MiB limit. Snapshot consumers use the existing 128 KiB limit. Reads recheck declared size and any supplied integrity hash at the point the bytes enter the payload. Unix opens refuse final symlinks and do not wait on FIFOs. Host/session/workspace authorization remains the caller's responsibility.
- Existing workspace/snapshot limits now live with the shared provider limits; desktop reexports them without changing their values.
- Shared reader tests passed for exact limits, declared-size mismatch, invalid UTF-8, smaller snapshot limit, symlink refusal and FIFO handling. `attachment-read-tests.log`.
- Core suite after image-reader integration: **1,175 passed, eight ignored**. After adding the snapshot consumer, all three shared-reader tests and **36 desktop provider tests** passed. Image/media, capability-manifest, chat session and persistence checks passed. No network/provider calls occurred. `core-after-attachments.log`, `providers-after-attachments.log`.
- Production frontend Vite build and complete reliability chain passed after loops 3–4. Artifacts are disposable under `/tmp/gyro-four-hour-20261117/desktop-build`; no installation or deployment. `frontend-production-build.log`, `reliability-after-loop4.log`.

## Loop 5 — bounded workspace reads and Git blame

- A disposable-directory regression confirmed that replacing a validated file's parent with an outside symlink could redirect the subsequent preview read. Workspace reads now traverse and open through pinned directory descriptors on Unix, refuse final links/FIFOs, bound allocation, and verify that the parent remains attached before returning bytes. Preview/range reads, save validation, memory reads, string edits, mutation proposal checks, hash-approved deletion, saved commands and Git review use this path. Existing descriptor-based writes were preserved.
- Workspace attachment preparation now hashes through a pinned parent; streaming media hashing refuses final symlinks/FIFOs and validates regular-file type and the known size before reading. Its symlink regression failed before and passes after. ACP workspace text rechecks the selected workspace boundary at consumption in addition to byte limits and integrity.
- Git blame previously reread mutable worktree paths and executed repository-configured fsmonitor, textconv and clean-filter programs. Two regressions failed before. Blame now uses the captured approved bytes and a disposable minimal Git metadata view with the source object database, no source config/attributes/index, an empty worktree, and scrubbed Git overrides. Tests cover uncommitted content, subfolder workspaces, SHA-1/SHA-256 objects and linked worktrees. The operation retains one 30-second deadline. Git review also explicitly disables textconv and uses descriptor-bound file reads.
- Desktop backend after the read integrations: **1,095 passed, 13 ignored**. Additional targeted Git history suite: **15 passed**; Git review suite: **eight passed**. Shared attachment reader: **four passed**. Workspace data safety, source-control lifecycle, architecture, 217-command blocking, 197-guard registry and diff-whitespace checks passed. Logs include `workspace-parent-read-before.log`, `git-blame-before.log`, `git-history-final-loop5.log`, `attachment-hash-before.log`, `desktop-after-loop5-reads.log`, `core-attachment-scope-after.log`, and `git-review-after-loop5.log`.

These filesystem guarantees were tested on macOS/Unix. The existing non-Unix fallback does not provide equivalent descriptor-relative race protection. Blame's isolated metadata intentionally omits custom config such as mailmap overrides. Other Git worktree-diff paths still honor configured clean filters; no claim is made that all Git reads are free of external programs. A probe confirmed that `GIT_ATTR_SOURCE` alone does not suppress `.git/info/attributes`, so it was not used as a security boundary.

## Loop 6 — remote file response races

- A deferred-host regression confirmed that a slow reload overwrote text typed after the reload began. Remote file reads now apply only to their original buffer and session, and only while they remain the latest open request. Linked-file opens also check the controller's selection generation and mounted state.
- A save response updates the saved base while retaining subsequent typing. It does not recreate a buffer removed or renamed while the write was pending, or replace a newer saved base.
- The existing remote regression guard executes the actual component handlers and linked-file opener with deferred responses. It verifies reload versus typing, save versus removal, save versus typing, overlapping file opens and navigation. The initial reload failure is retained in `remote-file-races-before.log`; passing checks in `remote-file-races-after.log` and `launch-regressions-loop6.log`.
- TypeScript, launch regressions, architecture and whitespace checks passed. The launch suite's PostgreSQL/API decoder wire test remains skipped without its required backend receipt; no hosted backend result is implied. Midpoint full Rust workspace: **2,392 passed, 22 ignored, zero failed** across 18 suites (`rust-workspace-midpoint.log`). The remote browser fixture passed 31 checks, including files/editor conflict handling, host selection, terminal, reconnect and light/narrow states (`remote-browser-loop6.log`; `/tmp/gyro-remote-browser/result.json`).

No layout, design tokens or action hierarchy changed. Deferred-host tests are behavioral source tests; browser/native/live-host evidence must be reported separately. Remaining inspection leads include hydration versus buffer deletion, and path mutations versus concurrent editor changes.

- Further hydration regression: a rename during startup could revive its old persisted buffer key. Hydration now treats keys removed since its read began as removed, while retaining unrelated recovered drafts; the React merge uses the same rule. `hydration-removal-before.log` fails before; `hydration-removal-after.log` passes after. TypeScript and remote client/media regressions pass. The browser run preceded this final hydration-only change.

## Loop 7 — mutation reads and diff work

- Extended descriptor-bound reads into core mutation proposal review/application, provider transaction preparation, Claude edit preparation, approval revalidation and recovery hash checks. The core parent-swap regression failed before and passes after; recovery and transaction behavior remain covered by the existing suite. `core-mutation-parent-before.log`, `core-mutation-parent-final.log`, `core-mutations-loop7.log`.
- Line counts and retained patches now share one diff calculation. Patch formatting stops at the existing 256 KiB retention limit and never emits a clipped patch. A sufficiently large replacement with no shared line returns exact counts directly instead of searching for matches that do not exist.
- Same local debug benchmark, five trials: 200 changed lines **689 to 388 microseconds**; 2,000 changed lines **59.3 to 30.0 milliseconds**. The 50,000-line/1.95 MB disjoint summary finishes in **33.9 ms**. The original oversized probe exceeded the measurement budget and was terminated; it is not a passing baseline or an exact speed ratio. Logs: `patch-summary-before-bounded.log`, `patch-summary-complete.log`.
- Exact patch compatibility tests cover empty text, unchanged text, unterminated lines, blank lines, CRLF, Unicode, malformed bytes, exact byte limits and omitted oversized patches with complete counts. Full core suite: **1,171 passed, eight ignored** (`core-after-loop7.log`). The two new benchmarks are explicitly ignored in ordinary test runs.

This measures the summary helper used during mutation preparation/application. Other upstream full-patch builders still use diffy's algorithm; this is not a claim that every large-file review has bounded computation time.

## Loop 8 — remote path actions and browser proof

- A completed host deletion could discard text typed after its confirmation. Keep those newer contents open and explain that the host file is deleted so the user can copy the draft. An unchanged confirmed deletion still removes the editor buffer.
- Slow rename/delete results preserve a newer selection. Renames refuse to overwrite an existing unsaved destination draft; if a destination draft changes while the host operation is pending, both drafts remain recoverable. Regressions failed before and pass after (`remote-delete-typing-before.log`, `remote-rename-draft-before.log`, `remote-rename-draft-after.log`).
- Added fixture-only pause/resume controls for file reads. The real-browser guard types into production Monaco while a host reload is held, releases the response, verifies the newer text survives, then saves it to the explicit host fixture. Passed with no runtime errors; screenshot `files-reload-race.png`, result and 32-check inventory copied under `/tmp/gyro-four-hour-20261117/remote-browser-loop8/`. This is browser fixture evidence, not a physical remote host or installed native acceptance.

## Loop 9 — remote terminal paste chunks

- A Unicode paste above the host's 64 KiB input limit was sent as one oversized frame and rejected. The regression reproduces that failure (`terminal-paste-before.log`). Client input now splits at UTF-8 character boundaries into ordered chunks up to 60 KiB, with the existing pending-input budget enforced in bytes. Each queued item records its byte length, avoiding repeated encoding of concatenated batches.
- New tests preserve exact text across an emoji at the chunk boundary, enforce frame bounds, reject a whole newer paste when backlog would exceed the budget, reject excessive multibyte pastes without sending, settle empty input, and never replay uncertain chunks or subsequent keystrokes. Passing: `terminal-paste-final.log`; TypeScript: `typecheck-after-loop9.log`.

- Full frontend reliability and a production Vite build passed after these changes. Build finished in **18.86 s**, with the existing large-chunk warning retained; no ceiling was raised. `reliability-after-loop9.log`, `frontend-build-after-loop9.log`. A production terminal browser check also preserved a large Unicode keyboard paste in two bounded host input frames; the complete remote fixture passed with artifacts in `/tmp/gyro-four-hour-20261117/remote-browser-paste/`.

## Loop 10 — remote audit writes

- Repeated audit updates no longer prune an unchanged row count. Pruning remains inside the insertion transaction; the 1,000-row retention and 50-row activity view are preserved. Added indexes for recent ordering and matching audit buckets.
- Disposable SQLite database with 1,000 rows, 200 coalesced writes, five trials: median batch time **99.6 to 23.8 ms**, about 76% lower. This measures local metadata writes, not remote round-trip latency. `audit-before.log`, `audit-after.log`.
- Remote crate suite: **38 passed, two ignored**; includes existing audit privacy/coalescing/retention, authorization, replay and local transport checks. `remote-after-audit.log`. The earlier security scan describes the pre-optimization snapshot.

## Loop 11 — image stream boundaries

- The client accepted a nonnumeric image total and kept requesting chunks until the controlled fixture stopped it. It now validates integer offsets/total, total size, chunk size, encoded payload size, nonempty revision, supported image MIME type, and stable total/MIME/revision across chunks. Invalid metadata fails on the first response. Tests also retain retry and Blob URL cleanup. `remote-image-metadata-before.log`, `image-metadata-final.log`.
- Two backend regressions failed before: a swapped authorized parent redirected an image chunk read, and same-size atomic replacement with restored mtime retained the same revision. Image chunks now open through pinned directories, check regular-file type/size, verify parent attachment and file version after reading, and include Unix file identity/change metadata in revisions. `image-chunk-before.log`, `remote-image-after.log`.
- Local cited-image previews preserve their resolved allowed root through the data read. Their header probe also uses a pinned nonblocking file open. Parent replacement regression failed before and passes after. The no-session/no-copy preview contract and Grok, workspace, attachment and browser-capture roots remain covered: **eight cited-image tests passed**. `chat-image-parent-before.log`, `chat-images-after-loop11.log`.
- Shared remote file-version metadata is reused for image revisions; its hash reader also uses a nonblocking open so a substituted FIFO cannot wait for a writer. Unix identity guarantees and non-Unix limitations remain as stated above.

## Loop 12 — interactive request admission

- Terminal input queued behind a catalog refresh burst. The client now admits interactive operations before queued background reads, preserving FIFO within each class and the shared eight-request budget. When both classes have work, regular work receives a slot after at most three interactive admissions.
- Controlled 50-read backlog, simulated 50 ms RTT, five trials: terminal input including its lease claim fell from **412.6 to 151.1 ms**. This is a simulated transport benchmark. A deterministic admission regression failed before and passes after; mixed-load tests verify both catalog progress and peak concurrency eight. `input-priority-before.log`, `input-priority-after.log`, `input-priority-regression-before.log`, `input-priority-final.log`.
- Three-hour full Rust rerun: **2,398 passed, 25 ignored, zero failed** across 18 suites. `rust-workspace-three-hours.log`. TypeScript, architecture and command blocking also passed.

## Loop 13 — catalog refresh ownership

- Refresh requests arriving during an active catalog read were discarded. They now coalesce into a follow-up for the affected hosts, or one full follow-up for manual/periodic refresh. A controlled hook regression failed before and passes after.
- The event debounce now retains all affected hosts instead of only the most recent one. Host display names participate in the catalog effect identity, so a renamed host cannot remain pinned to an old captured name.
- Actual catalog-hook tests cover overlapping refresh, partial project failures and two-host event coalescing. TypeScript passed. `catalog-refresh-before.log`, `catalog-refresh-final.log`, `typecheck-catalog-refresh.log`.

## Loop 14 — files first opened during hydration

- A further deferred regression failed: a buffer first opened and then renamed while the initial storage read was pending revived its older persisted key. The earlier initial-key merge could not see that intermediate buffer.
- Storage hydration now observes every buffer key that passes through in-memory state while its read is active. The React state setter also observes intermediate queued states, so batched open/rename updates retain the removal. Tracking stores keys only and is released after completion, failure or cleanup; React releases its tracking after the hydration commit.
- Passing evidence includes the actual view-state module, extracted production state setter/effects with batched and replayed updates, and real Chromium IndexedDB with a held read/write transaction. The old name remains absent, the renamed draft survives, and an unrelated recovered draft is retained. `hydration-open-rename-before.log`, `late-buffer-hydration-batched-replay.log`, `remote-storage-late-hydration-browser.log`.
- Complete frontend reliability, launch regressions, TypeScript and a production build passed after this correction. Build: **31.29 s**, with the existing chunk warning. `reliability-closing.log`, `launch-regressions-closing.log`, `typecheck-closing.log`, `frontend-build-closing.log`. No Rust code changed after the 2,399-pass full Rust run.
- The complete production remote-workspace browser fixture passed again: **33 checks, zero runtime errors**. Visually inspected the closing editor and light-mode captures. `remote-browser-closing.log`, `remote-browser-closing/result.json`. The task-owned Vite listener on 127.0.0.1:1439 was stopped after browser completion; unrelated services were left alone.
- The complete remote workspace browser fixture passed again after the correction: **33 checks**, zero runtime errors. `remote-browser-closing.log`, `remote-browser-closing/result.json`.

## Review artifacts and scope

- Compatibility review caught a regression introduced by the new saved-command reader: a `.gyro` alias pointing inside the workspace was rejected. Saved-command paths now resolve through the existing workspace authorization check before the descriptor-bound read. An internal alias succeeds; an outside alias is rejected. The new regression failed before the correction, and all **26 IDE tests passed** afterward. `custom-task-alias-before.log`, `ide-after-alias-fix.log`.
- Final whole-workspace Rust run: **2,399 passed, 25 ignored, zero failed** across 18 suites. Final TypeScript, launch-regression and complete frontend reliability checks passed. The reliability rerun required localhost-listener permission after the sandbox denied its disposable listener. `rust-workspace-final.log`, `typecheck-final.log`, `launch-regressions-final.log`, `reliability-final-unsandboxed.log`.
- Current production frontend build passed in **52.16 s** while other checks were running. The existing large-chunk warning remains; no warning threshold changed. This is a build result, not a comparable performance measurement. `frontend-build-final.log`.
- Final remote browser fixture passed **33 checks** with no browser runtime errors, including delayed Monaco reload, Unicode terminal paste, reconnect, and light/narrow states. `remote-browser-final.log`, `remote-browser-final/result.json`.
- Reran the current storage modules in real Chromium: remote 4 MiB legacy-buffer migration, replacement-database re-save, reload, host isolation and deletion passed; editor recovery restored a 2 MiB conflict draft and clearing did not resurrect it. `remote-storage-browser-final.log`, `workspace-recovery-browser-final.log`.
- Rebuilt the current debug backend and reran the isolated native broker smoke: **seven scenarios passed**, covering dependent/parallel reads, evidence parity, schema validation, workspace escape refusal, denied sensitive reads, multi-root routing, Plan/Council authority and Stop. This uses disposable app data and a scripted provider; no installed-app or paid-provider claim. `native-debug-build-final.log`, `native-code-mode-smoke-final.log`.

`/tmp/gyro-four-hour-20261117/changes-from-first-edit.patch` reconstructs this pass's changes from the starting tracked working checkout and saved before-first-edit copies for pre-existing untracked files. Its manifest lists covered paths. The small recovery-browser cleanup retry change lacks a saved original and is explicitly excluded from that patch. `.claude/launch.json` has an additional difference outside this pass's edit inventory and was left untouched. HEAD remains `143dc90d7548728d7deda704c2bd1a5f505c39cf`.

The review patch passes reverse-apply validation against the current files and a redacted secret scan found no leaks. Its one explicitly excluded file remains as documented above. The four-hour work period is complete; source hashes remained unchanged after closing verification. Installed-app, physical two-Mac, WAN, paid-provider and deployment acceptance remain outside the evidence gathered here.
