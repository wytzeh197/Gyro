# Backend upgrade: implementation and acceptance evidence

Objective: upgrade reliability, speed, safety, and performance from AI model
responses through page switching, preserving transitions. Status: **blocked on manual Mac unlock and access to two provider families; final local checks passed**.
Starting commit: `734648ec`; the checkout already contained substantial unrelated
UI, project-import, provider-health, and media work. That work was preserved.

## Current acceptance status

The full upgrade is **not yet verified complete**. Source fixes cover persistence,
configuration, blocking work, response streams, transcript refresh and history,
Ollama context/cancellation, provider access failures, and credential-read lifecycle.
Existing transition styles were preserved. No commit, push, release or installed-app
replacement has been performed.

| Gate | Current authoritative evidence | Status |
| --- | --- | --- |
| Latest Rust source | Latest workspace suite passed 1,081 tests with seven opt-in tests ignored (500 core, 518 desktop, 62 CLI and one fixture integration) | Current workspace source verified; native acceptance remains separately scoped |
| Frontend and command boundaries | TypeScript, production build, static workbench source/reducer checks with four declared viewport targets, 81 reliability guards, 164-command blocking scan and architecture checks passed | Source/build evidence only; the viewport smoke does not render screenshots |
| Deterministic scheduling | Same slow-IO fixture: transcript RPCs 21 → 2; peak concurrency 21 → 1 | Confirmed scheduling improvement |
| Live local response | Intact 18,039-token Ollama prompt; separate cancellation probe; original local edit trials remain 0/6 correct | Context preservation/cancellation verified; coding quality not established |
| Live native Codex | Fresh/resumed no-tool requests correct; coding cohort has three applied correct edits, two follow-ups staged for Review, one deadline stop | Separate current cohort; no before/after speed claim |
| Other live families | Claude organization refusal and protected DeepSeek credential read now produce failures instead of false success/stalls | Authenticated generation acceptance remains open |
| Native UI and transitions | Bundled native app passes draft/restart, workspace restoration, editing/save, diff/search, terminal lifecycle, actual Codex resume, scoped Git summaries, slow-preparation navigation and 1,000-file Git pending/failure/recovery; rendered minimum-size states inspected | Expanded chat-history/stress and transition/performance acceptance remain open |
| Latest native build | Fresh standalone native build passed after auxiliary-service ownership changes | Build verified; running bundle remains unchanged and native acceptance is blocked |

Detailed evidence and intermediate failures below are retained so later successful
checks cannot overwrite or hide the earlier results. The six requirement rows in
Remaining acceptance work preserve the original scope.

## Implemented in this pass

| Boundary | Confirmed problem | Change and verification |
| --- | --- | --- |
| Restart / legacy storage | An old database without `provider_id` tried to create its index before migrating the column. | Create the provider index after the additive migration. The eight-concurrent-opener regression failed with `no such column: provider_id` before the fix and passes afterward. |
| Approval configuration | A late config reader could cache old settings with a newer replacement's metadata. A cache hit also followed symlinks and checked only mtime. | Cache the opened file's version, including size and Unix inode/change-time identity. Validate bounded regular files without following links on cache hits. Saves invalidate the cache; in-place changes during reads are not cached. Regressions cover a late reader, preserved-mtime replacement, and a symlink to the cached file. |
| Terminal setup | Imported-login resolution and governed-pane setup did filesystem, SQLite, and Git work before the existing blocking worker. | Move the entire create operation to a blocking worker. Failed replacement retains the old pane's approval authority and retires the failed new authority. |
| Resource inspection | Active-resource listing read terminal state on the async runtime and copied scrollback just to obtain a title. | Perform inspection on a blocking worker and observe metadata without copying output. |
| System Settings | Opening the settings pane synchronously waited for `open` on an async worker and ignored its exit status. | Use the shared bounded process runner on a blocking worker, with a five-second deadline and checked result. The expanded command guard found this case before the fix. |
| Transcript refresh | Reads arriving more than 50 ms apart could overlap indefinitely on slow IO. | One active RPC per chat; immediate duplicates share it, later requests share one trailing read. Independent chats remain independent. Each caller settles after its own read, so continuous refreshes cannot starve a completed turn's cleanup. |
| Loaded history | Refreshing an expanded transcript reset its window to the recent page; a failed read could replace all durable history with a short optimistic tail. | Retain loaded earlier pages, merge refreshed durable IDs, and apply the larger bounded window throughout reconciliation. Failed and superseded reads preserve current history. Actual desktop callback regressions cover these cases and live activity during refresh. |
| Sparse response streams | A missing IPC sequence could hold tool-sparse activity until nine later frames or completion. Completed history could also evict a live turn's duplicate protection. | Allow 500 ms for normal reordering, then release received frames even if no new frame arrives. One timer covers all chats and is cleaned up on unmount. Retire completed order states before live ones, and discard frames beyond a terminal event. |
| Native browser verification | The smoke fixture used non-UUID session names, which no longer satisfy production session ownership checks. | Create real persisted test sessions and a child session for background-browser coverage. The updated harness reaches the foreground mouse guard; full completion still requires an unlocked Mac. |

No transition or animation styles were changed by this pass. Visual continuity
remains an acceptance item until checked in the native app.

## Measured fault behavior

[Raw fault evidence](../performance/2026-10-07-backend-upgrade/fault-evidence.json)
compares actual scheduling code from the starting commit and the current source.
For 101 requests over one second with RPCs deliberately held unresolved:

| Measurement | Before | After |
| --- | ---: | ---: |
| Transcript RPCs | 21 | 2 |
| Peak concurrent RPCs for one chat | 21 | 1 |

This is deterministic slow-IO fault evidence, not measured native paint latency.
The stream dispatcher tests separately prove recovery at the 500 ms grace
deadline, normal reordering within it, duplicate suppression after recovery,
terminal ordering, bounded state, and timer cleanup.

## Verification

- Full Rust workspace run passed: CLI 37, CLI integration 19, core 476,
  compatibility integration 1, desktop 506; 5 desktop live-account/install tests
  were ignored. Total: 1,039 passed.
- After the final Rust command and fixture changes, the complete desktop library
  suite passed again: 506 passed, 5 ignored, using one compiler worker and no
  incremental cache.
- TypeScript typecheck and workbench smoke passed after the transcript scheduler
  changes. The reliability runner now includes the new responsiveness regression
  and the previously unregistered chat-file-link guard.
- The blocking-command guard now scans all Rust command modules: 154 commands.
  This protects recognized blocking call sites; indirect helpers still require
  source and runtime review.
- Native LSP smoke passed definition, cross-file references, and document symbols.
- Native browser smoke first failed at its invalid session fixture, which was
  repaired. The rerun stopped at the foreground mouse precondition. Computer Use
  independently reported the Mac locked; an unlock request is pending.
- Production frontend build, architecture boundaries, timing, stream ordering,
  imported-history ordering, and whitespace checks passed during this pass.

The disk filled during two broad Rust rebuilds. Only regenerable Rust incremental
caches were removed. The subsequent complete desktop test run succeeded. This is
a build-host constraint, not evidence of a runtime performance regression.

## Live local-model evidence

The isolated native benchmark used the installed `ollama/qwen3:0.6b`, one trial
per task and fresh/resumed cohort, with a 60-second turn deadline. It did not
change the normal Gyro store, provider selection, or approval settings. Results
and content-free traces are saved under
[the local benchmark directory](../performance/2026-10-07-backend-upgrade/local/results-table.md).

Six measured trials produced four completed responses and two failures; **none
passed the requested-edit correctness check**. The failures were `Ollama
finished without a text response`. Completion times among completed trials ranged
from 3.86 to 45.72 seconds. Bootstrap turns are excluded from those six trials.
These results establish execution through the real local adapter and surface
failed outcomes; they do not establish coding quality, a latency improvement,
API/subscription behavior, or native rendering performance. Do not substitute a
different model and describe these trials as successful.

## Provider response and access follow-through (2026-10-08)

The original Ollama trials reported exactly 2,050 input tokens on each request.
The installed Ollama 0.34.2 server log confirms it clipped prompts of 7,176 to
11,309 tokens to that window. Gyro had not requested `num_ctx`, and its history
compaction used a model maximum rather than the actual runtime allocation.

The adapter now requests a context allocation sized to the intact request,
rounded to 4k blocks and bounded by discovered model metadata. It disables prompt
truncation and context shifting, and carries the allocated window forward through
tool rounds and compaction. The estimate selects allocation only; a tokenizer
rejection can retry the unchanged request once at the model maximum, only before
published text or partial tool calls. Unknown 400s and failures after output are
not replayed. Image base64 is not counted as text tokens. These API flags were
checked against the [installed Ollama version's request type](https://github.com/ollama/ollama/blob/v0.34.2/api/types.go)
and [prompt handling](https://github.com/ollama/ollama/blob/v0.34.2/server/prompt.go).

A first prototype allocated the entire 40,960-token model window, consumed
5.58 GB of runtime memory on this 8 GB Mac, and missed the 90-second probe
deadline. That failed attempt is retained. Adaptive allocation then processed
**18,039 input tokens** in **44.39 seconds** with a 20,480-token window and
3.00 GB of runtime memory. A separate live streaming probe cancelled immediately
after visible output and returned the cancellation result in **0.080 ms**. This
is a local transport-return measurement, not button-to-paint latency. Content-free
[probe artifacts](../performance/2026-10-07-backend-upgrade/probes/ollama-live-context.json)
include actual runtime token counts and memory allocation. Context length affects
memory use, as described in [Ollama's context documentation](https://docs.ollama.com/context-length).

The identical six original coding tasks were rerun with the same model and
60-second deadlines. Five failed (including resumed setup failures), one completed,
and **zero were correct**. The full prompts are now preserved, which has a cost
on this small host; these trials do not establish a speed or coding-quality gain.
The separate [after results](../performance/2026-10-07-backend-upgrade/local-after/results-table.md)
do not overwrite the original results.

Selected-model discovery now shares the cancellable pooled transport, a five-second
total deadline and a 4 MiB metadata bound. The CLI's existing timeout now covers
Ollama discovery and generation; Ctrl-C records cancellation and exits 130.
Early discovery failures settle the persisted run rather than leaving it running.
Real binary regressions stall model-list lookup, model metadata and generation,
and verify that deadline/cancellation closes each request and saves a terminal
status without a successful assistant message.

Native access probes exposed two further defects:

- Claude's configured `claude-opus-5-5` subscription returned an organization
  access refusal as assistant text and exited zero. Both fresh and resumed probes
  were incorrectly saved as successful turns. The exact standalone refusal is now
  excluded from assistant text and classified as a provider-configuration failure
  in both desktop and CLI. It directs the user to their administrator or an
  explicit API-key configuration choice, without switching authentication or retrying.
- The configured `deepseek-flash` API run did not settle after its 60-second
  benchmark deadline. A native process sample located the worker inside
  `SecKeychainFindGenericPassword` before generation. The isolated benchmark app
  was deliberately terminated after that evidence; normal app instances remained
  running. [Content-free fault evidence](../performance/2026-10-07-backend-upgrade/access-before/keychain-stall.json)
  records this path and the termination.

A per-query no-authentication-UI Keychain probe also hung and was terminated after
10 seconds. The SDK documents the file-based Keychain limitation, and Chromium's
[current compatibility code](https://chromium.googlesource.com/chromium/src/crypto/+/refs/heads/main/apple/scoped_keychain_user_interaction_allowed.cc)
confirms it. Disabling interaction inside a disposable process returned the actual
access error in 86 ms. Gyro now uses that process-isolated read with a three-second
deadline and bounded anonymous-pipe output. The main app's interaction policy,
stored credentials and access controls are unchanged. Settings writes retain their
existing interactive behavior. API sends, model discovery and health checks retain
read-access errors instead of describing a saved but inaccessible key as missing.
Regression fixtures cover stalled reader termination, denied versus absent keys,
and excluding malformed response material from errors.

The final Rust workspace run after these fixes passed **1,057 tests**: CLI 39,
CLI binary integration 22, core 487, compatibility integration 1, desktop 508.
Two opt-in local generation tests and five existing live-account/install tests
were ignored in the standard suite. Both local generation probes were run
separately as documented above. JavaScript reliability (78 reachable guards),
TypeScript, command blocking (154 commands), architecture and whitespace checks
also passed. The production frontend build and static workbench smoke passed. That
script declares four viewport targets (860x620, 1280x720, 1440x900 and 1728x1117)
but does not render them; it is source/reducer evidence. Native access reruns are
recorded below when complete.

The first native access rerun is retained under
[access-after](../performance/2026-10-07-backend-upgrade/access-after/results-table.md).
It confirmed the Keychain failure settled promptly, but caught a longer Claude
refusal suffix that the first matcher missed. The full observed wording was added
to the desktop/CLI regression fixture. The same rerun also exposed a benchmark-only
empty-effort serialization error for Codex; absent effort now maps to `None`,
retaining the provider default, while an explicitly selected effort is preserved.
Failed no-tool trials cannot be marked correct merely because the workspace is
clean. Summary tables now follow the requested task subset as well as its slot count.
The compiled native Keychain helper returned `denied` without credential data in
**952 ms**; [the direct probe](../performance/2026-10-07-backend-upgrade/probes/keychain-live-after.json)
records that result. Its process group is registered for application quit and
terminated as a group at the reader deadline. Codex API-key injection now uses the
same credential selection to set authentication arguments, avoiding a second
Keychain read for the same child command.

A repeated workspace test run hit five ACP fixture timeouts while another Cargo
compile was running on this 8 GB host. All 26 ACP tests passed when run alone.
The final suite is run after all other Cargo jobs exit, with four test workers;
its result is recorded below. The failed run has not been described as a pass.

The subsequent complete workspace run passed **1,059 tests** with four workers:
CLI 39, binary integration 22, core 488, compatibility integration 1, desktop 509.
The final reader protocol then added a kernel-authenticated private socket channel
and verified that the parent runs the same executable. Ordinary command invocation
cannot export credentials through the helper. The helper exits if its parent
channel closes, including after a hard app crash. Its final four core reader tests
and all **23 CLI binary integration tests** passed after this boundary change.
A further regression attempts an externally supplied socket channel as well;
its result and the final native access matrix follow below. Native compilation
also passed. These tests and source changes do not establish unlocked-Keychain
access or page-transition latency.

The external reader regression passed both ordinary invocation and a forged
socket-channel attempt, with no credential output. The final isolated native
[access matrix](../performance/2026-10-07-backend-upgrade/access-verified/results-table.md)
then produced these observed outcomes:

| Configured provider/model | Fresh no-tool request | Resumed request |
| --- | --- | --- |
| OpenAI / `gpt-5.6-sol` | Correct exact response, 6.54 s, zero tools/retries | Correct remembered keyword, actual native resume, 5.52 s, zero tools/retries |
| Anthropic / `claude-opus-5-5` | Organization policy failure correctly persisted, 4.48 s | Bootstrap failed on the same policy; no resumed generation was measured |
| DeepSeek / `deepseek-flash` | Keychain access failure correctly persisted, **199 ms** | Bootstrap failed on the same access boundary; no resumed generation was measured |

The DeepSeek result confirms Gyro's trusted parent channel reached the credential
read and returned its access error, rather than merely rejecting the private
reader protocol. The earlier direct 952 ms helper probe preceded this final
channel restriction and is retained as intermediate evidence. No subscription
policy, login, API key or model selection was changed. Codex's original coding
cohort is being checked separately; no-tool success alone is insufficient to
claim tool or coding correctness. Computer Use still reports the Mac locked.

The separate [Codex coding cohort](../performance/2026-10-07-backend-upgrade/codex-coding/results-table.md)
finished all six slots with the same fixture, default effort and a 60-second
turn deadline. Three trials produced correct applied edits (fresh/resumed README
and fresh clamp fix). The resumed clamp trial stopped at its deadline with two
pending proposals. Both follow-up trials completed with a staged workspace
proposal that still requires Review, so neither satisfies the applied-edit check.
Those two results demonstrate preserved review requirements; they are not
misreported as applied edits or attributed solely to model quality. No retries
were observed. These current Codex results are a separate cohort and do not
replace the zero-correctness Ollama comparison or prove a speed improvement.

A final source review found that legacy CLI key injection discarded Keychain
read errors. Actual desktop/CLI/ACP launches, context compaction, usage lookup and
CLI health now use fallible credential resolution and stop before launching a
provider when its saved key cannot be read. This avoids silently selecting a
different CLI account or authentication method. The prior optional/void helpers
remain for source compatibility; Gyro's launch paths use the fallible variants.
A fixture verifies the error is returned before changing command environment or
authentication arguments. Early CLI setup errors also settle the persisted run
and retain its existing resume cursor. Unit protocol fixtures use absent stored
credentials and do not read the user's Keychain; binary/native checks exercise
the production reader and its trust boundary.

The final rebuild again exhausted disk while creating a Rust static archive.
Only regenerable static libraries and stale own-crate object caches from before
October were removed, restoring 3.7 GiB free. Source, user files, media, bundles,
and existing running app instances were preserved. Final verification after the
fallible CLI change is recorded below.

The tightened credential boundary exposed test isolation problems rather than
successful authentication: unit test harnesses have no private reader entrypoint,
and temporary `HOME` values do not isolate the user's macOS Keychain. Protocol
unit fixtures now avoid stored-key reads. Mock-provider binary fixtures explicitly
select an empty debug credential store, restricted to a canonical temporary HOME;
regular app homes cannot activate it. Live native probes do not use that flag.
The private helper's ordinary and forged-channel invocation tests still exercise
the production entrypoint. A temporary-home boundary regression checks the debug
fixture restriction without reading any user credential.

The latest serial workspace run passed CLI 39, binary integration 23, core 489,
compatibility integration 1 and **508 of 509 desktop tests**. One desktop Git
shared-deadline fixture failed because its initial status was unavailable within
the 1.5-second budget. The implementation preserves that bounded failure; production
deadlines were not loosened. An isolated rerun is pending. This whole run is not
reported as green. Desktop tests took 674 seconds on the loaded host, versus about
11 seconds in the earlier four-worker pass. A contemporaneous
[host observation](../performance/2026-10-07-backend-upgrade/probes/host-verification-load.json)
recorded 7.6 GiB of swap and seven app processes near 90–100% CPU. Those unrelated
processes were left running. These are verification conditions, not a claimed
runtime regression or a controlled performance comparison.

The benchmark supports an explicit optional no-tool task subset for response and
resume checks; its default three coding tasks are unchanged. Resuming a benchmark
requires the original spec and refuses linked spec files, so changing task subsets
cannot silently mix cohorts. No-tool checks cannot establish coding correctness.

## Current executor verification (2026-10-08)

After the execution environment reset, the prior test handle and temporary logs
were no longer accessible. A new offline run of the unchanged Git shared-deadline
fixture passed in **1.88 seconds**. No production or test deadline was loosened.
Together with the recorded serial suite, all **1,061 tests** have passed, although
the earlier whole run retains its one failure. The fresh standalone native build and the complete reliability runner passed in
the current environment. The first sandboxed reliability attempt was unable to
bind a loopback fixture server; the authorized run outside that sandbox passed.

The blocking-work guard had missed scope-limited `pub(crate)` declarations. It now
recognizes scoped visibility, fails when it cannot parse a command instead of
silently skipping it, and tests those parser cases. It currently checks **163
commands**. The added commands have no recognized inline blocking-work violations.
A separate prefix audit found no recognized blocking calls before their first
blocking worker. Indirect helper behavior still requires native evidence.

Computer Use now inventories native apps successfully. Native journeys and the
browser smoke can resume after the current binary is built; this availability
change does not itself establish transition or latency correctness.

## Final verification checkpoint (2026-10-08)

The current native binary passed the complete browser smoke (**12 steps**) and
LSP smoke (**3 steps**). The [saved smoke log](../performance/2026-10-07-backend-upgrade/probes/native-smoke-final.log)
includes foreground/background interaction, capture, credential/stale-reference
rejection, navigation, definitions, references and symbols. The complete reliability
runner passed, including the expanded **163-command** blocking guard. The unchanged
Git deadline fixture passed its current isolated run in 1.88 seconds.

The [final adapter matrix](../performance/2026-10-07-backend-upgrade/adapter-final/results-table.md)
uses the current binary after fallible CLI credential propagation. Codex fresh and
actually resumed no-tool requests both passed (4.90 s and 3.87 s). Claude's
organization refusal remained a recorded failure. DeepSeek's inaccessible saved
credential remained a recorded failure before generation, settling in 162 ms.
Neither blocked family was reported as successful or retried using another
credential or model. These single trials do not establish a speed improvement.
The [final snapshot](../performance/2026-10-07-backend-upgrade/final-snapshot.json)
pins the native binary and relevant source hashes.

At the earlier locked-Mac checkpoint, a disposable project/store and a temporary local verification
bundle were prepared. Computer Use could not open it then;
the separate GUI test store had not yet been created. The earlier unbundled test process
was identified by its owned log and terminated. Existing apps, normal stores,
credentials and installed binaries were not changed. The temporary verification
bundle remains available for the next unlocked run.

The Mac subsequently became available and native UI checks resumed below. The two
provider-access blockers still prevent authenticated generation checks for those
families. The full requested upgrade has not been claimed complete.

## Bundled native UI follow-through (2026-10-08)

The temporary verification bundle now serves embedded assets at `tauri://localhost`
instead of sharing the live Vite frontend. Its disposable backend store and bundle
identity are separate from the installed app. Source/binary hashes are recorded in
[the native UI snapshot](../performance/2026-10-07-backend-upgrade/probes/native-ui-snapshot.json).
Ad-hoc signing changes the copied executable's bytes; it is not claimed byte-identical
to the unsigned build. No installed binary or normal app store was replaced.

Computer Use verified a draft across Sessions/Workspace, native README editing/save
(169 bytes confirmed on disk), and draft retention after a full quit/relaunch.
The first restart attempt used the default ephemeral test webview; its reset was
expected harness behavior. The successful restart used the existing
`GYRO_TEST_PERSIST_UI=1` opt-in. A prior editor reset during concurrent Vite source
reloads is inconclusive and is not classified as a production defect.

The persistent run found that a manually opened workspace without a chat had no
restored root. Startup now restores the most recently explicitly opened, nonremoved
folder and prepares it through the existing worker path. Explicit folder activation
also clears the current session owner and suppresses automatic reselection, so a
background turn's refresh cannot take over the folder. Trust decisions are not
modified by restoration. Actual callback regressions cover the refresh race,
chosen temp folders, empty history and removed projects. Native revalidation passed
with zero chats in the backend store: the fixture root, selected README, file contents
and source-control metadata restored while Restricted Mode stayed active.

An ordinary native fresh request using `gpt-5.6-sol` / Medium completed with the
exact requested response after navigating away from Sessions. Its isolated durable
transcript has one assistant response and no retry. The recorded backend completion
was 7.48 seconds. This is one current run, not a before/after latency result.
The earlier 793 ms frontend receive-to-frame value was collected while Workspace
was visible, so it cannot establish visible chat paint. The timing hook now gates
both scheduling and completion on the chat surface as well as document visibility;
regressions cover switching away between frames and returning later.
Content-free observations and original timing records are retained under
[native UI evidence](../performance/2026-10-07-backend-upgrade/probes/native-ui/observations.json).

The native journey also passed Working Tree diff viewing, a one-line workspace
search, shell input/output, shell exit to `done`, and closing its pane back to
`No terminal panes`. The inspected workspace states render in light and dark
appearance. The fixture theme was restored to System. These observations do not
measure frame rate or prove the OS Reduce Motion branch.

The full reliability rerun first caught `App.tsx` exceeding its architecture ceiling
by ten lines. The unchanged bounded local UI storage helpers were extracted into
`ui-storage.ts`; the subsequent complete suite passed all **78 guards**. TypeScript
and the production frontend build passed after that extraction. The failed run is
retained in the current verification logs rather than treated as a pass.

The saved native chat was reopened after a full quit/relaunch. Its actual Codex
resume returned the remembered keyword, with one durable assistant response,
`resumed: true`, and zero retries. Backend completion was 4.46 seconds. With the
chat surface visible, the gated frontend diagnostic recorded 45 ms from received
activity to the next post-commit frame opportunity. This is not a hardware paint
timestamp, navigation latency, or a before/after speed comparison.

That run exposed a transient false `Interrupted` / `Retry` state despite durable
success; the next transcript refresh reconciled it. No Retry was clicked. The RPC
completion callback had deferred its terminal events with `startTransition` while
clearing the sending flag at ordinary priority. Terminal responses now commit at
ordinary priority before that cleanup. The callback also no longer applies the
smaller recent-history bound before the existing expanded-window limiter. Actual
callback regressions prove immediate terminal delivery and retained loaded history.
Native follow-through passed on the rebuilt snapshot: another actual resume returned
the same keyword with one durable response and zero retries. The first post-send
observation showed `Worked` and the correct final answer, with no Interrupted/Retry
state. Earlier turns remained visible. This sampled observation is supported by
the synchronous callback regression; it is not a continuous frame trace.
That final run completed in 4.53 seconds in the backend and recorded 154 ms from
received activity to the post-commit frame opportunity. The two visible runs
therefore observed 45–154 ms; they do not establish an improvement between builds.
The full 78-guard suite, typecheck, production frontend build and bundled native
build passed after the fix. Current build/suite logs are saved with the native UI
evidence.

A separate observed ownership issue was found: the standalone chat Environment
displayed the previous fixture's Git summary beside `No workspace`. No Git action
was invoked from that state. The follow-through below fixes its ownership boundary.

## Git snapshot ownership and folder selection follow-through (2026-10-08)

Native Git snapshots now carry the requested `workspacePath`, independently of
their containing `repoRoot`. The owner is bound after every inspected result,
including cached/fallback results. File paths remain relative to that requested
workspace. The existing native subfolder regression checks both the serialized
owner and workspace-relative files. All 509 current desktop library tests passed;
five existing live-account/install tests were ignored.

IDE rendering, Git action inputs and per-turn baselines now consume only a snapshot
owned by their current workspace. Each tiled chat checks its own workspace.
Unknown or legacy owners do not supply another folder's files/counts, while matching
snapshots retain object identity. A no-workspace switch invalidates the old Git
read's publication guard. The current native standalone chat no longer displays
the fixture's +3/-0 counts or commit history, and its Git actions are disabled.

The owning-project native recheck found a second selection race: the chat-grid
reconciliation effect could restore its previously focused standalone chat after
the user opened a folder. Explicit folder activation now also activates that
project in the grid. The regression executes the actual reconciliation effect as
well as the session-refresh callback; both preserve the chosen folder. Native
follow-through passed: reopening the fixture from the standalone chat preserved
the chosen root through Search/Source Control navigation and populated its accurate
+3/-0 summary and fixture commit. The standalone context continued to exclude them.

Workspace and chat poses were rendered and inspected at a real minimum-size
861×622 window, including the editor, new composer and persisted transcript. The
image format/geometry was checked from its JPEG header; the window was restored
to the default size afterward. This sampled inspection does not establish frame
rate or all four declared viewport targets. The verification app exited and no
owned executable process remained.

Owner matching preserves whitespace in real directory names; it normalizes only a
trailing slash. Regression coverage prevents `/workspace/a ` from supplying
`/workspace/a`. The current frontend and native snapshot passed verification.

All 78 reliability guards, typecheck, production build and static workbench checks
passed for the ownership changes. The first workbench check caught a source-text
assertion still requiring the old unscoped baseline; it now requires the scoped
baseline and its scope hook. Its initial failure is retained. These checks do not
replace rendered native, history/stress or latency acceptance.

The native folder-opening sample also exposed a preparation-detail gap: the cheap
Git snapshot temporarily showed `Clean` and `No commits yet`, although the detailed
read then returned the known changes and commit. Preparation omits line statistics
and history; those omissions must be represented as unknown rather than zero/empty.
That follow-up is implemented and verified below on the rebuilt app.

## Unmeasured Git details and diagnostic worker (2026-10-08)

Preparation now serializes `detailsLoaded: false` and marks counts partial.
Detailed reads set the marker after attempting counts; history failures retain
their existing error state. The shared totals helper shows `Loading changes…`
instead of `Clean`, history shows `Loading history…`, and terminal controls avoid
printing zero counts for incomplete reads. First-turn baselines skip incomplete
counts. A real Git regression verifies a modified tracked file and an existing
commit through preparation, detailed read and cache reuse, including preservation
of the detailed cache after another cheap preparation read.

The timing command previously called the filesystem writer inline. Local Tauri
2.6.3 command-macro source confirms synchronous wrappers invoke their function
directly; they do not automatically dispatch a blocking worker. Timing persistence
now uses an async command with `spawn_blocking`, retaining validation and the
opt-out fast path. The command guard now checks recognized blocking calls in both
sync and async commands, including the indirect diagnostic writer. All 163 commands
pass. Remaining synchronous commands are the opt-in check and menu/window controls;
the sampled menu helpers update memory or invoke native UI operations.

Current source checks passed: typecheck, production build, 78 reliability guards
(71 behavioral, seven source-text), static workbench/reducer checks and all six
Git cache tests. The first reliability invocation stopped at sandbox loopback
permission (`listen EPERM`); the approved retry passed. The first desktop run
passed 504 tests and failed six attachment/IPC fixtures at sandbox permission
boundaries. Its retry uses an isolated temporary data directory and approved
socket access; all 510 tests passed, with five opt-in tests ignored. The native
build passed. The subsequent terminal-row and selection follow-ups also passed
typecheck, production frontend/native builds and all 78 guards. Earlier interrupted build handles disappeared and
their incomplete logs were not accepted as successful builds.

The native 1,000-file fixture reached accurate `+1,000/-0` uncommitted totals,
1,000 changed files, one commit, and the existing 60-row cap (`940 more files not
shown`). A fixture-only filesystem-monitor hook deliberately delayed later Git
reads; it was removed after the sample. This is correctness and bounded-presentation
evidence, not a latency comparison.

That sample exposed two further preparation races. Before any owned result,
unavailable history still said `No commits yet`; the shared history helper now
distinguishes unavailable, pending, failed, empty and populated reads. Folder
selection also awaited full preparation before its caller created the chosen
chat, so finishing preparation could pull the user back to Sessions after they
had navigated to Workspace. Activation now settles after selection and starts
preparation in the background; the existing preparation run-ID/error guards
remain in force. The actual activation callback regression holds preparation
unresolved and verifies selection settles first. The pre-fix native sample is retained in
`probes/native-ui/preparation-before-selection-timing-fix.json`.

Latest native follow-through passed. Before an owned result, history showed
`History unavailable.` With a fixture-only delay limited to Git diff parents,
preparation showed `Loading changes…` alongside its known 1,000 changed files.
The deliberate shared-budget failure showed `Count unavailable` and a history
retry message, retaining all changed files. Removing the delay and refreshing
restored `+1,000/-0` and the single fixture commit. Folder selection started its
chat while preparation was still `Inspecting Git · 40%`; after navigating to
Workspace, the page stayed selected through failure and recovery. The existing
60-row cap and `940 more files not shown` were confirmed in the native view.

The loading-history branch has behavioral helper coverage; sampled native history
states were unavailable, explicitly failed and recovered, so this run does not
claim a rendered loading-history sample. No latency/frame-rate improvement is
inferred from Computer Use call times. The fixture's old editor tab was preserved;
this sample validates Git and navigation rather than editor restoration across
folders. The fixture-only delay was removed, the app quit, and process inspection
found no owned executable or fixture-path Git/helper process. Current hashes,
native results, and successful/failed logs are saved in
`probes/native-ui/preparation-final-verification.json` and its verification-log folder.

## Page timing and representative history fixture (2026-10-08)

Opt-in diagnostics now record reducer-dispatch to React commit and two subsequent
frame callbacks for primary destinations and Workspace views. Startup records the
webview time origin to the first App commit and its later frame opportunity after
the diagnostics check. These are defined frontend boundaries, not native process
launch, first interactive composer, animation completion, or hardware paint times.
Original actions still dispatch once, and transitions/styles are
unchanged. Opt-out schedules no diagnostic frames/writes and skips target prediction.
Only fixed surface enums and bounded numerical durations can reach the local
filesystem writer, which runs on a blocking worker. Superseded or hidden page
measurements are discarded, and cleanup cancels outstanding frames.

Actual reducer/hook regressions cover startup, primary/Workspace navigation,
opt-out, no-op/superseded actions, hidden-between-frame cancellation, 1,000 queued
transitions with bounded frame state, and React Strict Mode cleanup. Core schema
tests reject arbitrary content/path fields, non-finite/unbounded durations, reversed
commit/frame times, and invalid startup/navigation shapes. Typecheck, production
frontend build, all 79 guards (72 behavioral, seven source-text), and the complete
490-test core library suite passed. Desktop suite/build and native timing evidence
are pending.

The new `backend_acceptance_fixture` core example creates only a new temporary
directory through `SessionStore`, refuses existing destinations, and executes no
model/tool request. It generated separate 1,200-turn, 300-turn, 10-turn and empty
sessions. The longest has 3,601 durable events, a 401-event tail including the
creation event, and a separately verified older 400-event page. Its first attempt
incorrectly asserted that `read_events` returns all history; that API deliberately
returns a bounded 1,000-event tail. Disk inspection confirmed all 3,601 events were
intact. The corrected example explicitly requests the generated count for fixture
verification, and the retry succeeded in a fresh directory. The initial directory
and failure log are preserved. Native expanded-history/page-switch and restart
acceptance remains open until exercised in the separate history verification app.

The first native timing run caught a rendering error on Workspace navigation and
produced no timing record. The hook had supplied browser frame/cancel methods as
detached functions. It now invokes them on `window`; a receiver-sensitive regression
reproduces the detached-method failure and validates the bound hook through the
actual reducer. The rendering failure and its snapshot are retained in
`probes/native-history/native-before-receiver-fix.json`. The first corpus also
used temporary project paths, which the sidebar deliberately excludes. A new
corpus uses standalone session paths instead; no sidebar filtering rule was weakened.
Typecheck, frontend build and the corrected regression passed; the final native
build and expanded-history rerun are pending. The initial Computer Use launch
call took 75 seconds; that tool-observation duration is not used as app latency.

The corrected native run passed primary page navigation and wrote valid local
timing records. One cold webview sample recorded 2,348 ms to first App commit and
2,434 ms to its frame opportunity. The long-history fixture's first round trip
recorded 56/82 ms to Workspace and 137/243 ms back to Chat (commit/frame opportunity).
After older-page loading, the round trip recorded 187/223 ms and 236/507 ms.
These five samples are current-build boundaries, not before/after gains or
animation/hardware-paint timings. The slower expanded return needs follow-through.

The 1,200-turn chat opened its bounded tail, displayed `HISTORY_1200`, and retained
its unsent fixture draft across Workspace navigation. Older pagination preserved
the on-screen `HISTORY_1068` anchor, and scrolling then reached `HISTORY_0944`.
After another page round trip, older `HISTORY_0952` remained reachable. Restart
and manual re-selection restored the draft and latest durable reply. All 4,534
fixture events across four chats remained unique with no tool/approval event added.
Accessibility snapshots omitted transcript content after pagination, so those
reading-position observations were confirmed from native pixels. Imported/active
turn restart and a longer resource soak remain open.

Native restart also exposed a startup reconciliation race: the saved grid retains
its focused session, but the first empty in-memory session list deleted that pane
before the durable list arrived. Reconciliation now waits for the first successful
session read. A later failed read preserves known sessions/panes; an authoritative
empty read still removes missing sessions. Actual callback/effect regressions cover
all three cases. The measured reducer setup moved into its existing module to
keep App within its architecture ceiling. Typecheck and all 79 guards passed.
The first native rebuild ran out of disk; with no active Rust build, package-scoped
`cargo clean -p gyro-desktop` removed 16.7 GiB of generated artifacts. The retry
passed without source or evidence deletion.

Returning to Chat also reset the viewport to the latest message. A bounded,
process-local scroll-memory helper now retains reading/following state by session,
adjusts for a prepended page, and refuses to restore an evicted history window.
Actual hook remount tests cover independent chats, geometry changes, explicit
latest/following behavior and bounded eviction. This remains **source-only** until
the updated native app confirms the transcript viewport's restoration. Final
typecheck, all 80 guards (73 behavioral, seven source-text), and frontend/native
builds passed. The Mac locked
before the final restart check; manual unlock is pending. The running v3 bundle
still contains the receiver fix, not the subsequent hydration/scroll changes.
Current ready-build hashes and successful/failed logs are saved separately in
`probes/native-history/ready-build-snapshot.json`; it does not assert native
acceptance for code that has not yet run in the signed history bundle.

## Shared transcript connectivity watch (2026-10-08)

Source review of the slower expanded-history return found that every `ChatTurn`
installed its own browser online/offline listeners. The watch now lives once in
`ChatSurface`, which passes the current boolean to each turn; the transcript memo
includes that boolean, preserving live retry/connection presentation. With the
same actual hook executed for a 400-turn fixture, subscriptions fall from 800
browser listeners to two. Regressions cover both network directions, a transition
between the initial read and subscription, and complete listener cleanup.
This establishes bounded subscription overhead, not a native paint/latency gain.

The current surface maps every loaded turn into React components. Earlier references
to a “virtualized viewport” were an inference from accessibility item ranges;
source review does not support that claim. Scroll restoration acceptance now refers
to the actual transcript DOM. The source changes retain existing styles/transitions.
The first typecheck and frontend/native builds passed. The full suite then caught
the surface file's architecture ceiling. The browser connectivity hook was extracted
into `use-network-online.ts`; its behavior and the architecture check pass. Final
typecheck, full 81-guard suite (74 behavioral, seven source-text), and frontend/native
builds passed. The source/method counts and exact hashes are saved in
`probes/native-history/shared-network-subscriptions.json`. Native
restart, reading-position and comparable latency checks still require manual Mac
unlock; Computer Use confirmed it remains locked this turn.

## Provider session ownership and crash audit (2026-10-08)

Startup previously closed every indexed running turn. Multiple desktop hosts are
supported through per-process IPC sockets, so startup in one process could mark
another host's active turn failed and make its tools replayable. Provider runs now
hold a private per-session kernel lease before dispatch through final persistence.
Recovery acquires the same lease nonblockingly and rechecks durable status after
acquisition, excluding live sessions and turns that finished after enumeration.
Lease files remain in place after release to keep all hosts locking the same inode.
Symlinks, nonregular files, and hard links are refused. Older hosts without leases
are handled conservatively: a live or ambiguous existing IPC endpoint defers their
recovery and a second dispatch; stale sockets do not. This may defer an unrelated
old abandoned turn while another older host is open. The check does not wait on a
full socket backlog.

The final complete desktop suite passed **516 tests**, with five opt-in tests
ignored. **51 core session tests** passed. The actual two-process regression keeps
the live child's turn running, force-quits that child, and recovers its abandoned
status once. Other regressions cover stale enumeration, completed-status survival,
independent sessions, legacy host endpoints, and lease path refusal. The initial
sandbox run denied a temporary Unix socket bind; the escalated scoped and final
suites passed. Architecture, 164-command blocking, chat persistence and turn timing
guards passed. The static native build passed, but the already running native
verification bundle was not replaced. Windows lease code was not compiled or run;
its exclusive-sharing contract follows [Rust OpenOptionsExt documentation](https://doc.rust-lang.org/std/os/windows/fs/trait.OpenOptionsExt.html#tymethod.share_mode).

A separate owned mock-CLI probe through the real core command runner confirmed a
remaining crash-cleanup defect: after force-quitting its owner, the CLI child still
ran and wrote its temporary fixture file. The probe cleaned up only its own process
group and made no provider/account requests. Normal quit/Drop cleanup does not
prove force-quit cleanup. The lease regression proves live-host ownership and
abandoned status recovery; it does not prove provider descendants stop when their
host dies. That process-lifecycle fix remains required before crash safety is
accepted. Logs, probe source/results and exact source/build hashes are saved in
`probes/native-history/session-lifecycle-evidence.json` and adjacent files.

## Provider process watchdog and measured launch cost (2026-10-08)

The preceding crash probe's defect is fixed for macOS provider process groups.
The desktop and CLI mains dispatch a private helper before starting UI/CLI runtime.
The shared command runner, desktop/CLI Codex app-server launchers and ACP launcher
now arm that watchdog before the provider can exec. A private socketpair verifies
the kernel peer PID and matching executable; the kernel also verifies the provider
is a direct child of that host and leads its own process group. The watchdog uses
[kernel process exit notifications](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html), with bounded SIGTERM/SIGKILL cleanup when the host dies or the provider exits.
It inherits the held session lease, excluding restart recovery until crash cleanup
has finished. Provider stdin/stdout, request arguments, models and approval policy
retain their existing paths. Deliberately detached processes have a separate
lifetime; the guarantee applies to the owned provider process group.

The actual two-process regression force-quits the owner, observes kernel exit
notifications for both a TERM-ignoring mock leader and its child, and verifies the
lease stays locked through cleanup before becoming available. Additional cases
reject mismatched ownership and invalid groups, and reap the helper after a failed
provider spawn. The standalone production-helper-entrypoint probe also passes:
the same owned mock no longer survives the cleanup grace or writes its delayed
fixture. The probe's owned process group is gone. Neither probe contacted a
provider or used an account.

The final complete workspace suite passed **1,075 tests**, with seven opt-in tests
ignored: core 496, desktop 516, CLI unit/integration 62, fixture integration one.
All **81 reliability guards** passed (74 behavioral, seven source-text), as did
the static native build and architecture/164-command checks. Intermediate failures
are preserved: the initial JS run hit the sandbox's loopback restriction, and one
ownership comparison needed a syntax repair before the final workspace run.

A same-executable shared-runner comparison with 40 `/usr/bin/true` samples per
condition measured median **1.009 ms** without the watchdog and **31.447 ms** with
it, using alternating block orders. This establishes about **30.438 ms** extra in
that standalone fixture. It does not measure the desktop executable's startup or
model latency. Reusing a watchdog within each provider run is the next performance
improvement, while preserving the arming and lease guarantees. No native UI
acceptance is inferred from the source build. Exact hashes, logs, probe sources,
results and raw samples are in `probes/native-history/process-guard-evidence.json`
and adjacent files. The running native verification bundle was not replaced.

## Watchdog reuse across a provider run (2026-10-08)

One watchdog is now reused by a provider run's model and capability workers.
The active run control carries a shareable process owner; the capability broker
enters that owner after validating the active-run nonce. A missing or poisoned
owner fails closed when crash cleanup is enabled. CLI invocations also retain one
owner across their commands. Helpers start lazily, and separate/nested owners keep
independent leases and watchdogs. Only the short registration/exec handshake is
serialized; command execution remains concurrent.

Each command receives a distinct registration generation. Its cleanup cannot
release another command or a later reused PID. The helper tracks at most 64 live
process groups, buffers the bounded 13-byte control frames without blocking its
exit watcher, and cleans all owned groups together after a host crash. The session
lease stays held while cleanup escalates. Regressions observe kernel exits for
four TERM-ignoring processes across two groups started on separate threads, after
first reusing the helper across a completed command. Other cases exercise worker
reuse, startup failure followed by successful reuse, generation mismatch, nested
owners and final idle lease/helper release.

The corrected standalone comparison used two immutable probe builds, the same
20 `/usr/bin/true` commands per run, and alternating block orders. The observer
checked only children of its own probe and identified helper argv after exec.

| Condition | Observed helpers per 20-command run | Median command time, 40 samples | Whole-run wall time, two cohorts |
| --- | --- | --- | --- |
| Per-command watchdog | 20, 20 | 28.217 ms | 528.49, 643.49 ms |
| Reused watchdog | 1, 1 | 2.521 ms | 64.08, 55.77 ms |

These are command-runner fixture measurements, not native desktop paint, model
latency or billing savings. The first observer used executable paths and counted
some command children before exec as helpers; its incorrect helper counts are
preserved and explicitly marked invalid. Final counts use the private helper's
startup argument. No environment data is decoded or recorded. The earlier core
test compile also referenced the removed `prepare` method; the fixtures were
updated before the subsequent green runs.

The complete workspace suite passed **1,078 tests**, with seven opt-in tests
ignored. All **81 reliability guards** passed. A subsequent peer-identity audit
found the legacy-host check could mistake this app's own listener for another
host. The macOS kernel peer PID now excludes this host; another process's listener
still defers recovery. The actual two-process regression and own-listener case
pass, along with the subsequent **518-test** complete desktop suite (five ignored).
Architecture and the 164-command boundary checks pass. The final static native
target rebuilt successfully; the running native verification bundle was not
replaced. The normal production-helper-entrypoint crash probe still prevents the
mock's delayed write. Exact hashes, raw samples, observer/probe sources, logs and
limits are saved in `probes/native-history/watchdog-reuse-evidence.json` and
adjacent files. Native UI and blocked provider acceptance remain required.

## Auxiliary services and bounded resource soak (2026-10-08)

Language servers, debug adapters, and Codex/Grok usage services previously started
raw children outside the crash watchdog. They now use independent service owners,
so a persistent service does not retain the model turn's session lease or command
registry. The existing protocol handling, usage deadlines, and explicit stop paths
remain in place. Debug-adapter disconnect still distinguishes launched and attached
debuggees; the watchdog covers the owned adapter process group, not an independently
attached target or deliberately detached process.

The focused ten-test process-guard suite passes. The new regression holds a model
lease, starts a persistent service, drops the model scope, then acquires that lease
while the service remains alive. Dropping the service reaps its child and watchdog.
Architecture, all 164 command boundaries, and the language-server registry checks
also pass. The final workspace suite passed **1,081 tests**, with seven opt-in
tests ignored (500 core, 518 desktop, 62 CLI, one fixture integration). The static
native build passed in 34.29 seconds; the running verification bundle was not
replaced. Source/build hashes and logs are saved in
`probes/native-history/service-lifecycle-evidence.json` and adjacent files.

A separate production-entrypoint command-runner soak completed 2,000 owned mock
commands across four workers in 4,040 ms: 1,840 successes and 40 each of missing
executable, cancellation, timeout, and output-limit outcomes. After scope drop,
the root returned to its starting three descriptors and one thread, with no child
processes remaining. The helper stayed at five sampled descriptors. Root RSS
increased by 1,228,800 bytes; this does not establish zero memory growth or whole-app
leak freedom. This cohort predates the independent service wrapper and verifies
the shared command runner only. It used no provider, account, or UI. Raw samples,
source, hashes, and limits are saved in `probes/native-history/runtime-soak-evidence.json`
and adjacent files.

Computer Use again confirmed the Mac is locked. Native workspace/browser/LSP/terminal
soak, restart/scroll/transition acceptance, comparable UI timings, and the blocked
provider generation checks remain open.

## Remaining acceptance work

The original scope remains open. Completion requires evidence across all of the
following boundaries, rather than treating the changes above as the whole task.

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| AI response reliability and cancellation across supported execution families | HTTP/CLI/ACP fault tests; complete Rust suites; live Ollama context/cancel; native Codex fresh/resumed response and edit trials; explicit access failures | Verify authenticated API fresh/resumed generation and cancellation after Keychain access is available, and complete Claude generation after organization access is restored. Keep models, efforts, approvals, and usage accounting intact. |
| Stream correctness and responsiveness | Actual reducer/callback/dispatcher regressions, source hashes, deterministic slow-IO comparison; native background completion and visible activity frame timing; terminal priority recheck | Extend native typing/chat-switch stress and verify final transcript reconciliation after lost frames. |
| Startup, page switching, and transitions | Native current-build webview/App-commit and primary navigation samples with long/expanded fixture history; 81 guards; pending scroll-restoration source fix | Verify updated transcript scroll restoration, reduce the slower expanded return, collect comparable native before/after and first-interactive-composer timings; inspect reduced-motion runtime behavior after manual unlock. |
| Persistence and restart safety | Legacy migration/config regressions; generated long-history pagination, navigation and restart/manual re-selection preserve the draft and all 4,534 unique fixture events; new startup hydration and refresh-failure regressions | Verify automatic focused-chat restoration in the rebuilt native app, then active-turn/imported-history restart with no duplicated side effects. |
| Workspace, Git, review, terminals, browser, language servers | Current broad Rust/JS suites; complete native browser/LSP smoke; native editing/save, diff/search, terminal lifecycle, scoped Git metadata, folder choice, 1,000-file pending/failure/recovery and owned process drain; 2,000-command mock soak; independent auxiliary-service ownership regression | Owned process-group force-quit cleanup passes kernel-observed and production-entry probes. Watchdog reuse reduced the measured fixture launch cost; native workspace/browser/LSP/terminal resource soak remains open. The diagnostic writer and all recognized sync/async command boundaries are covered. |
| Performance claims | Deterministic request-count reduction and current local measurements | Collect comparable before/after user-visible timings. Do not infer latency, billing savings, or task-quality gains from source checks or zero-correctness trials. |

No commit, push, release, or installed-app replacement was made.
