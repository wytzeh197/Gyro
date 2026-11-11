# Desktop backend split: full plan

This is a handoff for an agent continuing the work. It covers:

- splitting `apps/desktop/src-tauri/src/lib.rs` into domain modules (Phase 1);
- adding a `ProviderRunner` trait (Phase 2);
- moving the runners out of the desktop crate (Phase 3).

## Execution progress (latest first)

- **DeepSeek desktop follow-up (2026-11-09):** fix the wrong-path create failure with explicit `createIfMissing` intent, concrete same-name root-file recovery and exact path/read-only proposal guidance. Guidance-only failures retained. Final unchanged strict native code cohort passed 4/4 (two fresh, two history-seeded), correct code-file paths; full event audit retained one pending setup memory proposal, never applied. Model-scope compliance is not claimed perfect. Desktop 997 tests pass / 12 ignored; locked all-targets check has zero new warnings. See `../performance/2026-11-09-deepseek-path-recovery/README.md`. No approval scope widened, installed-app modification, purchase, model download or push. Historical DeepSeek gate text below is superseded by this result; broader frontend/platform acceptance remains unverified.

- **Acceptance scope correction (2026-11-09, authoritative user clarification):** Wytze has no Kimi/Antigravity subscription/access or available downloaded Ollama model, and no budget/disk space to add them. Exclude all three from this acceptance run; no purchase, sign-in setup, model download or storage change is required. Earlier probes, model labels and setup-gate requests below are historical and superseded. Available live scope is Codex/Claude/DeepSeek (CLI accept/deny/resume/Ctrl-C passed). Keep the separate desktop DeepSeek wrong-path reliability and native/frontend verification limits explicit. Do not claim unavailable-provider live tests passed.

- **3.4 decision complete (2026-11-09):** retain providers in `gyro-core::provider_runtime` (10,543 Rust lines / 29 files). Three warm mtime-only samples per location give medians desktop 2.049 s, core 4.286 s, provider 4.574 s. These are observational timings, not a controlled speedup claim; provider vs desktop difference is within the baseline's ~3 s noise band. No separate-crate benefit was measured, so another crate is not justified now. Full implementation plan completed; see the newer scope correction above for unavailable providers and the remaining desktop/native limits. See `../performance/2026-11-09-backend-split-result/README.md`. No new crate, push or remote PR.

- **3.3 code and terminal checkpoint complete (2026-11-09, `270a307a`):** CLI uses the common registry and all adapters through `CliRunnerHost`; duplicate native loops removed. Headless file tools, durable approvals, actual guarded writes, explicit CLI Codex budgets, cancellation and acknowledged resume bindings are verified. Claude's real background terminal-input hang was fixed with a foreground approval relay. Full workspace passed: desktop 993 / core 1,019 / CLI 43 unit + 25 exit + 1 install + 2 shared API tests; zero new desktop warnings. Native Codex/Claude/DeepSeek each passed accept, deny, resume and Ctrl-C. Installed Kimi returned subscription HTTP 403; Antigravity needs sign-in; Ollama qwen3:0.6b failed exact edit/refusal while resume/cancel passed. Desktop Codex/Claude code recheck passed; DeepSeek's fresh wrong-path failure retained. See `../performance/2026-11-09-backend-cli-host/README.md`. Own local review prepared; no remote push/PR. Wider manual acceptance is partial.

- **3.1 code checkpoint complete (2026-11-09):** all six adapters, shared execution contracts, policy-parameterized tool loops/context helpers and the registry now live in `gyro-core::provider_runtime` without Tauri. Desktop keeps `TauriRunnerHost`, the actual tool catalog, prompt assembly, attachment validation and trusted capture/image storage. Shared runtime: 9,472 lines across 28 files. Locked all-targets check has zero new warnings; full workspace tests pass (desktop 1,004 / core 1,005 passed, 12 / 2 ignored). Native `all-core-runners` fresh/resumed code tasks pass for Codex, Claude and DeepSeek with applied task-file approvals. The wider live acceptance gate remains partial for the documented provider setup/model limitations and extra Codex compaction checks.

- **3.2 code checkpoint complete (2026-11-09):** one core `CodexClient` owns process spawning, bounded protocol reading/writing, stderr collection and teardown for chat, compaction, account usage and the CLI. Desktop/CLI budgets remain explicit. Full workspace, CLI all-targets and zero-new-warning desktop checks pass. Native Codex tool/MCP/edit approvals/resume and real manual compaction/keyword recall passed. Claude's out-of-task-path failure is retained alongside its successful unchanged-task retry. Wider provider setup/model gates remain open.
- **2c code checkpoint complete:** `52fa7d73` dispatches directly to host-based adapters, removes `run_legacy`, queries readiness and retry ownership, and routes Codex compaction through the runner trait. Desktop and full workspace suites passed with zero new warnings. The Phase 2 manual gate remains open.
- **Implementation continuation complete:** all phases through 3.4 have code/decision checkpoints. CLI host is `270a307a`, with a dedicated local review branch. Remaining work is external/manual acceptance as recorded below; do not claim that matrix passed. No push, new crate or remote PR. Ask before creating a crate if that decision is revisited.
- **Automation scripts are already applied:** `/tmp/gyro-move-contracts.py`, `/tmp/gyro-core-antigravity.py`, `/tmp/gyro-core-claude.py`, `/tmp/gyro-core-acp.py`, `/tmp/gyro-core-codex-foundation.py`, `/tmp/gyro-core-codex-transport.py`, `/tmp/gyro-core-codex-runner.py`, and `/tmp/gyro-prune-codex-core.py`. Do not rerun these item-removal scripts. Phase 2 replay snapshots under `/tmp/gyro-phase2-final` are historical only and would overwrite Phase 3 work. Use current code and commit diffs for subsequent work.

- **2026-11-09: 2b implementation checkpoint; live acceptance still partial.** All six runners take `&dyn RunnerHost`; no runner contains `AppHandle`, `tauri::Manager`, or application state access. The host owns events/accounting, cancellation/reasons, checkpoints, history, heartbeat cleanup, capability execution, approvals/MCP configuration and command streaming. Local checkpoints: API/Ollama `eca04dec`, ACP `84807686`, Antigravity `83f6ac6f`, Claude `5bfe3dca`, Codex/compaction `ecb851cd`. Each checkpoint passes locked all-targets check, 1,021 desktop tests (12 ignored), formatting and architecture checks with no new warnings. These are implementation checkpoints, not a passed manual matrix.
- **Native acceptance evidence:** [`../performance/2026-11-09-backend-provider-host/README.md`](../performance/2026-11-09-backend-provider-host/README.md). The latest `core-reviewed` cohort passed fresh/resumed code tasks for Codex, Claude and DeepSeek, with actual native resume for Codex/Claude and applied task-file approvals for all three. Prior append-only failures and missing reviewer channels remain recorded. Extra Codex compaction/MCP checks remain open. Kimi's installed CLI rejects the existing stdio MCP entry; Antigravity requires Google sign-in; the installed Ollama `qwen3:0.6b` failed tool/task checks. Do not describe this matrix as passed. All native runs used PID-verified debug binaries, temporary stores and disposable workspaces; frontend/window interaction was not measured.
- **Native approval reviewer checkpoint:** `81e1d83d` uses the real provider/capability resolvers only for opted-in existing task-file updates and diff/status inspection calls in disposable stores. Full tests and zero-new-warning check passed.
- **Acceptance harness checkpoint:** `16fe88db` adds opt-in `requireFileEditApproval`, requires the scoped fixture reviewer, records/rechecks the posture on resume, and clarifies append punctuation without relaxing verification. Default benchmark behavior is preserved.
- **Next acceptance gate:** resolve/verify the provider setup and strict task failures above, then repeat the per-provider tool/approval/resume check before accepting Phase 2 or Phase 3 runtime changes. The user has been asked asynchronously about an alternate Ollama model and Antigravity sign-in. No model download, installed-app replacement, provider protocol workaround, push, or new crate was performed.

- **2a dispatch foundation complete** in `79fcf998`: synchronous `ProviderRunner`/`RunnerHost`, one registry entry per adapter kind, Tauri host wrapper, request/resume/attempt forwarding tests, and unchanged image/readiness policies. The temporary `run_legacy` host bridge will be removed as 2b ports replace it with actual application callbacks. Desktop suite: 1,021 passed, 12 ignored. Full workspace suite passed. Locked all-targets check, zero-new-warning report, architecture and formatting checks passed. No push.
- **Phase 1 accepted** at `467a4ea1`: `lib.rs` 125 lines; central test fixtures 593 lines; wildcard baseline empty; largest production file is `session_browser.rs` at 3,034 lines (about the 3k target). Required desktop checks pass with 1,018 tests and 12 ignored; native browser feature checks pass. Moved platform gates and remaining root-relative references were reviewed; Linux cross-compilation was not run because the target is not installed. Warning comparison rebased only the two existing warning file paths changed by optional module renames.
- **1.12 complete** in `467a4ea1`: Organize loose git IDE and provider lifecycle modules. `lib.rs` 125 lines; central tests 593 lines. All required checks passed, with 1,018 tests passing, 12 ignored, zero new compiler warnings. No push.
- **1.11 complete** in `12a1a2f8`: Colocate desktop tests with their domains and retain shared fixtures. `lib.rs` 135 lines; central tests 593 lines. All required checks passed, with 1,018 tests passing, 12 ignored, zero new compiler warnings. No push.
- **1.10 complete** in `84047bbb`: Remove parent wildcard imports and root compatibility aliases. `lib.rs` 236 lines; central tests 9414 lines. All required checks passed, with 1,018 tests passing, 12 ignored, zero new compiler warnings. No push.
- **1.9 complete** in `74d8fcb5`: `lib.rs` 662 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.8 complete** in `0fa13cda`: `lib.rs` 1,726 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.7b complete** in `26abd400`: `lib.rs` 5,362 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.7a complete** in `169015ff`: `lib.rs` 11,481 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.6 complete** in `da4acfe3`: `lib.rs` 15,153 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.5 complete** in `6121a93b`: `lib.rs` 16,566 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
- **1.4 complete** in `5bbd1ab8`: `lib.rs` 19,235 lines; locked all-targets check, 1,018 desktop tests (12 ignored), formatting, architecture checks, and move verification passed; zero new warnings. No push.
## Historical continuation (2026-11-08; superseded by execution progress above)

- **Phase 1.3 complete:** local commit `9f19efbe` (`Move git terminal IDE and browser runtime into domain modules`). Nothing pushed.
- Extracted `git/{commands,github}.rs`, `ide/{tasks,debug,task_discovery}.rs`, `terminal/{panes,governance}.rs`, and `browser/preview.rs`, all with explicit imports. Existing domain modules keep their wildcard-import lint.
- `lib.rs` is now **20,965 lines**, down from 24,313; its size ceiling was ratcheted. The wildcard baseline is unchanged.
- Verified moved code and remaining root code with a Rust token comparison that handles raw strings and character literals, excluding imports, visibility, formatting, and command-handler path changes. All **197 Tauri handler registrations** remain in the same order; **47 relocated commands** now use module paths.
- Reviewed the moved Linux, non-macOS, macOS, and Unix gates. The native snapshot type and terminal process-inspection imports have matching macOS gates. Removed complete cfg-gated root imports together with their attributes to avoid attaching a dangling gate to the next item.
- Validation: locked all-targets desktop check passed; desktop tests **1,018 passed, 12 ignored, 0 failed** outside the restricted sandbox, plus binary/doc tests passed; warning report **0 errors / 0 new warnings**; architecture boundary, formatting, and diff checks passed.
- Tooling caveats: `move2.py` missed the final `write_terminal_input` handler because it has no trailing comma; fixed its path manually. `split.py imports` repeatedly suggested `mpsc::TryRecvError` instead of importing `std::sync::mpsc` for the debug module; fixed manually. Root-import pruning used a temporary corrected helper to handle full-path diagnostic names and remove attributes when an entire cfg-gated import is deleted.
- **Next: Phase 1.4 — workspace tree, preparation, files, and paths.** The original item map still supplies selectors; resolve items by name rather than the old line numbers.

## Continuation progress (2026-11-08)

- **Phase 1.2 complete:** local commit `519d6a6b` (`Extract desktop state and shared domain types`). Nothing pushed.
- Moved shared constants into `app/limits.rs`, state into `state/{managers,workspace,provider_run}.rs`, and all domain `types.rs` / `providers/chat_types.rs` ranges in the slice map. Explicit imports throughout; each new domain `mod.rs` denies wildcard imports.
- `lib.rs` is now **24,313 lines** (from 26,152); its size ceiling was ratcheted. The wildcard baseline stays unchanged because this slice did not convert any existing wildcard modules.
- Verified moved code and remaining root code against the starting source with a token comparison, excluding imports, visibility, and formatting. Preserved the macOS gate on `BrowserPreviewSnapshot` and its root import. Checked removed root imports for uses under other platform gates.
- Validation: locked all-targets desktop check passed; desktop tests **1,018 passed, 12 ignored, 0 failed**, plus binary/doc tests passed; warning report **0 errors / 0 new warnings**; architecture boundary and formatting checks passed.
- Environment: the first test build ran out of disk space. `cargo clean -p gyro-desktop --profile dev` cleared generated build artifacts. The restricted sandbox then denied local sockets and child-process confinement tests; the full suite passed when rerun outside that sandbox.
- Tooling caveat: `rootfix.py` missed test-only root imports whose diagnostic highlighted a full path (`state::workspace::WorkspaceRescanState`, `usage::types::CodexRateLimitWindow`). These were restored manually under `#[cfg(test)]`. Derive macro imports still need to be added explicitly as described below.
- Phase 1.3 was the next slice at this checkpoint; see the newer continuation above for its completion. Resolve ranges by item names against the original item map; its line numbers remain the starting snapshot.

The rest of this document records the original handoff and overall plan.

## Starting snapshot (2026-11-08, branch `Heads/v0.1.1`)

| Commit | What |
|---|---|
| `5ae59d78` | The user's WIP, committed before the split started. |
| Phase 0 (already in history) | `scripts/check-architecture-boundaries.mjs` now fails CI when `lib.rs` grows past its ceiling, or when a module not on the list uses a top-level `use super::*` / `use crate::*`. Baselines: `scripts/architecture-size-baseline.json` and `scripts/architecture-wildcard-import-baseline.json`. Timing baseline: `docs/performance/2026-11-08-backend-split-baseline/README.md`. |
| `2778ea7b` | Phase 1, first slice. `automation/` (`mod.rs`, `commands.rs`, `runtime.rs`, `execution.rs`, `scheduler.rs`) moved out of `lib.rs`. `lib.rs` ceiling is now **26152**. `automation_scheduler.rs` is off the wildcard list. |

The working tree is clean apart from two untracked paths. **Never commit these:**

- `docs/performance/2026-11-08-browser-split/projects/`
- `scripts/__pycache__/`

Current sizes:

- `lib.rs`: 26,152 lines, about 930 top-level items.
- `tests.rs`: 9,744 lines.
- The wildcard baseline still lists 58 modules.

## Ground rules (every commit)

1. **Moves only in Phase 1.**
   - Code is moved, never changed.
   - The only edits allowed are `pub(crate)` visibility, import lines, `mod` lines, and handler paths in `generate_handler!`.
2. **Explicit imports.**
   - No new `use super::*` or `use crate::*`.
   - Every new folder's `mod.rs` starts with `#![deny(clippy::wildcard_imports)]`.
   - The exception is `mod tests { use super::*; }` blocks.
3. **Run these before each commit. All must pass with 0 errors and no new warnings:**
   ```bash
   cargo check -p gyro-desktop --all-targets --locked
   ```
   ```bash
   cargo test -p gyro-desktop --locked -- --test-threads=4
   ```
   ```bash
   node scripts/check-architecture-boundaries.mjs
   ```
   ```bash
   cargo fmt -p gyro-desktop
   ```
4. **Ratchet the baselines in the same commit.**
   - Lower the `lib.rs` ceiling in `scripts/architecture-size-baseline.json` to the new line count.
   - Remove a file from `scripts/architecture-wildcard-import-baseline.json` when it stops using the glob or moves. The check fails if the list is stale.
5. **Commits:**
   - Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
   - Don't push unless the user asks.
6. **Leave pre-existing clippy warnings alone** in moved code. Fixing them isn't a move.

### Rust mechanics to know

- **Visibility.** Root-private items are visible crate-wide, so moved code needs `pub(crate)` on:
  - top-level items;
  - named struct fields;
  - inherent-impl methods and consts;
  - tuple-struct fields (`struct Foo(pub(crate) T)`).

  Prefer narrower visibility such as `pub(in crate::providers)` where it's obviously enough. `pub(crate)` is acceptable during the move.
- **Root re-exports keep the rest compiling.** After a move, add `use domain::file::{names};` at the root of `lib.rs`. The remaining wildcard modules and `tests.rs` use `use super::*`, and that glob picks up private root imports. Copy each item's `#[cfg(...)]` onto its re-export. Prune these re-exports at the end of Phase 1.
- **Tauri commands.**
  - In `generate_handler!`, refer to a moved command by its module path, e.g. `automation::commands::list_automations`.
  - A `pub(crate)` command fn is fine.
  - When `run()` itself moves to `app/setup.rs`, every handler entry needs a `crate::` prefix.
- **Sorting unused root imports.** `--all-targets` JSON can't tell the prod and test builds apart, so compare two builds instead:
  - `cargo check -p gyro-desktop --lib`
  - `cargo check -p gyro-desktop --lib --profile test`

  Then:
  - unused in both builds: delete;
  - unused only in prod: put behind `#[cfg(test)]`.
- **Platform gates.** CI's desktop tests run on macOS only, but `release.yml` also runs `cargo test` on ubuntu and macos-15-intel. `lib.rs` has 22 non-mac `#[cfg(...)]` gates (`target_os = "linux"/"windows"`, `unix`, `windows`). Imports used only inside those gates aren't checked locally. Review every moved non-mac gate by hand and give its imports the same cfg.

## Tooling (`docs/backend-split/tools/`)

These are Python helpers written for this split. They are **not committed**. They hard-code `/Users/wytze/Gyro`.

| Script | Status | What it does |
|---|---|---|
| `split.py baseline` | used | Saves the current warning keys to `warn-baseline.json`. Run this before every slice. |
| `split.py imports FILE...` | used | Loops `cargo check` and adds missing imports to each file inside a tagged `// @split-imports-start/end` block. It picks paths from rustc's suggestions, then the paths `lib.rs` already imports, then `crate::name`. The `crate::` prefix for local-module paths has now been fixed but not yet exercised. |
| `split.py prune FILE...` | used | Applies rustc's unused-import removals that aren't in the baseline. |
| `split.py finalize FILE...` | used | Removes the tags. |
| `split.py report` | used | Prints errors and **new** warnings. The target is `0 error diags, 0 new warning diags`. |
| `move.py SPEC.json` | used for automation | Moves one item per selector. Selectors: `fn` / `struct` / `enum` / `const` / `static` / `type` / `trait`, `impl X`, `impl-for Trait X`. |
| `move2.py SPEC.json` | **written, untested** | Moves a range, from a start selector to an end selector, including everything in between. It also adds `pub(crate)`, adds root re-exports between `// @moved-reexports-start/end` with cfg attrs copied, rewrites `generate_handler!` entries for `#[tauri::command]` fns, and adds `mod` lines and `mod.rs`. Test it on a small slice first and read the diff. The `mod` insertion line (`text.startswith("mod") is False ...`) is fragile, so check it. |
| `rootfix.py` | **written, untested** | Applies prod-build unused-import removals to `lib.rs`, and re-adds names used only by tests as `#[cfg(test)] use path;`. |
| `root_unused.py` | used | Reports unused `lib.rs` imports by build: both / prod_only / test_only. |
| `lib-items-at-2778ea7b.txt` | reference | The item map: start line, length, kind, name. Line numbers drift after each slice, so locate items by name or selector, never by line. |

**Still missing:** imports inside inline test modules. When an unresolved-name error falls inside a column-0 `mod x { ... }` block, insert the `use` inside that block, not at the top of the file. Otherwise `prune` deletes test-only imports from the top of the file.

Per-slice loop:

1. `split.py baseline`
2. `move2.py spec.json`
3. `split.py imports <new files>`
4. `rootfix.py`
5. `cargo fmt -p gyro-desktop`
6. `split.py report` (until 0 / 0)
7. `split.py finalize <files>`
8. tests
9. baselines
10. boundary check
11. commit

Hand-written moves are fine too. The scripts just save time.

## Phase 1: split `lib.rs` (moves only)

Target layout under `apps/desktop/src-tauri/src/`:

```
lib.rs          < 400 lines: mod list + run() → app::setup
app/            setup.rs (run_entrypoint, run, Builder, .manage, plugins), shutdown.rs,
                limits.rs (shared consts), config.rs, commands.rs
state/          managers.rs, workspace.rs, provider_run.rs
sessions/       commands.rs, events.rs, attachments.rs, review.rs, titles.rs
workspace/      types.rs, tree.rs, preparation.rs, files.rs, paths.rs
git/            types.rs, commands.rs, github.rs
ide/            types.rs, tasks.rs, debug.rs, task_discovery.rs
terminal/       types.rs, panes.rs, governance.rs
browser/        types.rs, preview.rs
council/        commands.rs
usage/          types.rs, commands.rs, fetch.rs, guard.rs
diagnostics/    types.rs, export.rs
providers/      types.rs, chat_types.rs, commands.rs, change_summary.rs, compaction.rs, run.rs,
                binding.rs, prompt.rs, approvals.rs, health.rs, codex_app_server.rs, retry.rs,
                cli_args.rs, markers.rs, events.rs, streaming.rs, stdout.rs, process.rs,
                runners/{kimi_acp,codex,antigravity,claude}.rs
capabilities/   types.rs, commands.rs, bridge.rs, access.rs, approval.rs, execute.rs, mcp_server.rs
stores.rs  text.rs  ipc/cli.rs
automation/     (done)
```

### Slice map

Line numbers are from `lib-items-at-2778ea7b.txt`, at the 26,152-line `lib.rs`. Resolve each range by the item names at its edges. Where a target lists several ranges, they all go into the same file.

| Lines | Target |
|---|---|
| 247–357 | `app/limits.rs`: shared consts |
| 360–538 | `state/managers.rs`: managers, task runs, admissions, guards |
| 539–608 | `state/workspace.rs` |
| 609–857 | `state/provider_run.rs`: pending approvals, `ProviderRunControl`, `ProviderStopReason`, `stop_provider_run` |
| 858–918, 952–1011, 1304–1352 | `workspace/types.rs` (1304–1352 holds the workspace-preparation types) |
| 919–951 | `capabilities/types.rs` |
| 1012–1203 | `git/types.rs` |
| 1204–1303, 1353–1388, 1394–1417 | `ide/types.rs` (1394–1417 holds the debug adapter manager and process) |
| 1389–1393, 1418–1496 | `terminal/types.rs` |
| 1497–1857 | `providers/chat_types.rs` |
| 1858–1969 | `browser/types.rs` |
| 1970–2115 | `providers/types.rs` |
| 2116–2170 | `usage/types.rs` |
| 2171–2215 | `diagnostics/types.rs` |
| 2216–2227, 2247–2589, 2604–2671 | `sessions/commands.rs` |
| 2228–2246, 2590–2603 | `app/commands.rs` |
| 2672–2747 | `providers/commands.rs` |
| 2748–3828 | `council/commands.rs` |
| 3829–4030 | `providers/change_summary.rs` |
| 4031–4104, 5024–5145 | `providers/compaction.rs` |
| 4105–4145 | `sessions/review.rs` |
| 4146–5023 | `providers/run.rs` |
| 5146–5546 | `providers/binding.rs` |
| 5547–6041, 18190–18347 | `providers/prompt.rs` |
| 6042–6119, 6736–6775 | `sessions/events.rs` |
| 6120–6735 | `sessions/attachments.rs` |
| 6776–6932 | `app/config.rs` |
| 6933–7084 | `usage/commands.rs` |
| 7085–7184 | `capabilities/commands.rs` |
| 7185–7537 | `workspace/tree.rs` |
| 7538–7866 | `workspace/preparation.rs` |
| 7867–7993, 9500–9770 | `workspace/files.rs` |
| 7994–8117, 16298–16864 | `providers/approvals.rs` |
| 8118–8278, 9771–10275 | `workspace/paths.rs` |
| 8279–8846 | `git/commands.rs` |
| 8847–8942 | `git/github.rs` |
| 8943–9091 | `ide/tasks.rs` |
| 9092–9499 | `ide/debug.rs` |
| 10276–11396 | `ide/task_discovery.rs` |
| 11397–11702 | `terminal/panes.rs` |
| 11703–11800, 12359–12387 | `providers/health.rs` |
| 11801–12358 | `browser/preview.rs` |
| 12388–13186, 13402–13479 | `usage/fetch.rs` |
| 13187–13401 | `providers/codex_app_server.rs` |
| 13480–13631 | `diagnostics/export.rs` |
| 13632–13863 | `usage/guard.rs` |
| 13864–14332 | `providers/retry.rs` |
| 14333–14842 | `providers/runners/kimi_acp.rs` |
| 14843–16297 | `providers/runners/codex.rs` |
| 16865–17056 | `providers/runners/antigravity.rs` |
| 17057–17320 | `providers/runners/claude.rs` |
| 17321–17518, 17951–17969, 19053–19148 | `providers/cli_args.rs` |
| 17519–17783 | `capabilities/bridge.rs` |
| 17784–17950 | `terminal/governance.rs` |
| 17970–18189 | `sessions/titles.rs` |
| 18348–19052 | `providers/markers.rs` |
| 19149–19514, 21138–21359 | `providers/events.rs` |
| 19515–19605 | `text.rs` |
| 19606–20585 | `providers/streaming.rs` |
| 20586–21137, 21360–21406 | `providers/stdout.rs` |
| 21407–21683 | `providers/process.rs` |
| 21684–22177 | `capabilities/access.rs` |
| 22178–22620 | `capabilities/approval.rs` |
| 22621–24398 | `capabilities/execute.rs` |
| 24399–24989 | `capabilities/mcp_server.rs` |
| 24990–25421 | `app/setup.rs`: `run_entrypoint` and `run`. Move this **last** and add `crate::` to the handler entries. |
| 25422–25544 | `app/shutdown.rs` |
| 25545–25668 | `stores.rs` (`parse_uuid` and `to_string` can go to a small util module) |
| 25669–26053 | `ipc/cli.rs` |

`providers/runners/codex.rs` (about 1,450 lines) and `capabilities/execute.rs` (about 1,780 lines) are both under the 3k limit, so they can move as they are.

### Commit order (least tangled first, one commit each)

1. **1.2 State and types:** `app/limits.rs`, `state/*`, and every `*/types.rs` / `chat_types.rs`. After this, the later slices mostly import types instead of defining them.
2. **1.3 Git, terminal, IDE, browser:** `git/commands.rs`, `git/github.rs`, `terminal/panes.rs`, `terminal/governance.rs`, `ide/tasks.rs`, `ide/debug.rs`, `ide/task_discovery.rs`, `browser/preview.rs`.
3. **1.4 Workspace:** `workspace/tree.rs`, `preparation.rs`, `files.rs`, `paths.rs`.
4. **1.5 Sessions and council:** `sessions/*`, `council/commands.rs`, `app/commands.rs`, `app/config.rs`.
5. **1.6 Usage and diagnostics:** `usage/commands.rs`, `fetch.rs`, `guard.rs`, `diagnostics/export.rs`.
6. **1.7a Provider pipeline:** `providers/commands.rs`, `change_summary.rs`, `compaction.rs`, `run.rs`, `binding.rs`, `prompt.rs`, `health.rs`, `retry.rs`, `approvals.rs`.
7. **1.7b Provider runners and streaming:** `providers/runners/*`, `codex_app_server.rs`, `cli_args.rs`, `markers.rs`, `events.rs`, `streaming.rs`, `stdout.rs`, `process.rs`, `text.rs`.
8. **1.8 Capabilities:** `capabilities/commands.rs`, `bridge.rs`, `access.rs`, `approval.rs`, `execute.rs`, `mcp_server.rs`.
9. **1.9 App:** `app/shutdown.rs`, `stores.rs`, `ipc/cli.rs`, then `app/setup.rs` (`run`). Add `crate::` prefixes in `generate_handler!`. `lib.rs` is now only `mod` lines plus `pub fn run() { app::setup::run() }`, or a thin `run_entrypoint`.
10. **1.10 Remove the wildcards.** Convert the remaining 58 modules from the wildcard baseline, plus `tests.rs`, to explicit imports with `split.py imports`. Several per commit is fine. Empty the baseline JSON as you go. Then delete the root re-export block in `lib.rs` (`// @moved-reexports-*`) and anything else in `lib.rs` that's only there for the globs.
11. **1.11 Tests move with their code.** Split the 9.7k-line `tests.rs` into `#[cfg(test)] mod tests` blocks, or `tests.rs` files, next to the modules they test. Lower or remove the `tests.rs` size cap.
12. **1.12 (optional)** Move existing loose files (`git_*.rs`, `language_server*.rs`, `provider_retry_recovery.rs`, …) into their domain folders. Rename detection makes these cheap to review.

**Phase 1 is done when:**

- `lib.rs` is under 400 lines;
- `rg 'use (super|crate)::\*;' apps/desktop/src-tauri/src` matches only `mod tests` blocks;
- the wildcard baseline is empty;
- no non-test file is over about 3k lines.

Then review the 22 non-mac cfg gates by hand.

## Phase 2: `ProviderRunner` trait (inside desktop, about 5 commits)

**Today.** There are six `run_*_chat` functions with nearly the same signature. They're picked by a `match` in `run_provider_chat_once`, which will be in `providers/run.rs` after Phase 1. Each takes `&tauri::AppHandle` and uses it for four kinds of things:

- **Events:** `emit_provider_activity_event`, `emit_turn_tokens`, `emit_provider_context_usage`, `publish_streamed_session_title`.
- **Approvals:** `wait_for_provider_approval`, `remove_pending_provider_approval`, `notify_provider_approval_question`.
- **Cancellation:** `provider_chat_cancelled`, `provider_stop_message`.
- **Capability bridge:** `codex_capability_mcp_config_args`, `active_provider_capability_context`.

Core already follows this pattern in two places: `run_kimi_acp` takes callbacks (`on_delta`, `on_activity`, `on_approval`, `on_write_file`), and the CLI's `run_codex_app_server` does the same.

The target shape is below. It stays **synchronous**: runners already run on blocking threads inside the session lease, and making them async would be a rewrite.

```rust
pub trait RunnerHost {
    fn emit(&self, event: RunEvent); // TextDelta, Activity, Tokens, ContextUsage, Title, RateLimits
    fn is_cancelled(&self) -> bool;
    fn request_approval(&self, req: ApprovalRequest) -> Result<ApprovalDecision>; // blocking
    fn capability_bridge(&self) -> Option<CapabilityBridge>; // MCP config for CLIs that call back into Gyro
    fn conversation_history(&self, req: &RunRequest) -> Option<String>;
}

pub trait ProviderRunner: Send + Sync {
    fn kind(&self) -> ProviderAdapterKind;
    fn supports_images(&self, req: &RunRequest) -> bool;
    fn is_executable(&self) -> bool { true }
    fn run(&self, host: &dyn RunnerHost, req: &RunRequest,
           resume: Option<&ResumeCursor>, attempt: &mut RunAttempt) -> Result<RunOutput>;
    fn compact(&self, /* … */) -> Option<Result</* … */>> { None } // only Codex today
}
```

### Steps

1. **2a: trait and host wrapper, with no logic change.**
   - Add `providers/runner.rs` with the two traits.
   - Add `TauriRunnerHost { app: AppHandle, … }`, which calls the existing `emit_*`, approval, cancellation and bridge functions.
   - Wrap each of the six `run_*_chat` functions as a `ProviderRunner` impl that just calls the existing function.
   - Replace the `match` with `runner_for(kind).run(host, …)`.
   - Behaviour must be identical.
2. **2b: move the runners onto `&dyn RunnerHost` one at a time, easiest first. One commit per runner, or two small runners per commit:**
   1. OpenAI-compatible and Ollama;
   2. Kimi/ACP;
   3. Antigravity;
   4. Claude;
   5. Codex, last, because it has approvals, MCP and compaction.

   Each runner stops taking `&AppHandle`. Every `AppHandle` use goes through the host.
3. **2c: replace adapter-kind checks with trait queries:**
   - the `ReadinessOnly` checks in `agent_session_worker.rs`, `automation/` (formerly `automation_scheduler.rs`) and `providers/run.rs` (formerly `lib.rs:4996`);
   - the `OpenAiCompatible | Ollama` check in `provider_retry_recovery.rs` (about line 411).

   They become `runner.is_executable()`, `runner.supports_images(..)` and similar.

**Manual check after each 2b step:**

- In the **dev build**, send one message per provider: Codex, Claude, Kimi, Antigravity, Ollama, and one OpenAI-compatible provider.
- Each one must get through a tool call, an approval and a resume.
- The installed Gyro.app hosts real chats, and the dev build runs alongside it. Check the window's PID to make sure you're testing the dev build.

## Phase 3: move the runners out of desktop (about 3 commits, first visible behaviour changes)

1. **3.1: Into core.** Move the request, attempt, output and cursor types, the traits, and every runner that no longer depends on Tauri into `gyro-core`. Desktop keeps `TauriRunnerHost`.
2. **3.2: One Codex client.**
   - Desktop spawns `app-server --stdio` in three places. Merge them with the CLI's `codex_app_server.rs` into one client in core.
   - Re-run the full provider check above, with extra care on Codex: approvals, MCP bridge, compaction, resume.
3. **3.3: CLI runner host.** This is a **behaviour change**.
   - The CLI gets a `CliRunnerHost` that prints to stdout and asks for approvals in the terminal.
   - The CLI then uses the same runners as the app.
   - Do this as its own PR and check by hand in the terminal: each provider, approvals (accept and deny), cancellation with Ctrl-C, and resume.
   - The CLI's `main.rs` is capped at 7,367 lines in the size baseline. Lower the cap if the file shrinks.
4. **3.4: Decision.** Choose between keeping the providers in `gyro-core` and creating a `gyro-providers` crate, based on the sizes after 3.1. A separate crate is where the real compile-time gain is: the baseline is about 12.4 s for `cargo check` after touching desktop `lib.rs` and about 9.7 s after touching core `lib.rs`. Splitting the code into modules within one crate (Phase 1) won't change these numbers much. **Ask the user** before creating a crate.

## Checks per phase

| Phase | Must pass |
|---|---|
| 1 (every commit) | `cargo check -p gyro-desktop --all-targets --locked`, `cargo test -p gyro-desktop --locked -- --test-threads=4`, `node scripts/check-architecture-boundaries.mjs`, `split.py report` = 0/0, and the baselines ratcheted. Reviewers can read the diff file by file, since it only moves code. |
| 2a, 2c | The above, plus `cargo test --workspace --locked`. |
| 2b, 3.x | The above, plus the manual per-provider check in the dev build (tool call, approval, resume). 3.3 also needs the manual CLI check. |
| End of Phase 1 | Hand review of the 22 non-mac cfg gates. Optional: `cargo check --target x86_64-unknown-linux-gnu` if that target is installed. |

## Gotchas from the automation slice

- `git add` on a file already staged as a rename fails with "pathspec did not match". Leave that path out.
- Derives need their macro imports, e.g. `use serde::Deserialize`. Rustc doesn't always suggest these.
- When moved code was imported both through a root re-export and through a `gyro_core::{…}` tree, you get a duplicate import error. Remove the name from the `gyro_core` tree.
- Rustc gives no import suggestion for names the root itself imports. `split.py`'s fallback to the root's `use` paths handles this.
- Other branches that edit `lib.rs` (`feature/workspace-parity-phase2a`, `codex/*`) will conflict. Keep each commit small and merge it quickly.
