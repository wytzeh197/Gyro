# Backend reliability, speed, and stability upgrade

Date: 2026-09-29
Starting checkout: `v0.1.0`, `334688c`
Scope: `gyro-core` storage and process runtime; desktop workspace, Git,
terminal, language-server, provider-stream, startup, and quit paths.

## Method

Three read-only audits (storage/sessions, process/provider runtime,
workspace/Git/startup) produced about 40 source-confirmed findings. Every fix
below was re-confirmed in code before changing it and carries a regression test
unless noted. The uncommitted plan-mode and questions UI work already in the
checkout was left as it was. No commit or release was made.

## Data-loss and correctness fixes

| Area | Defect | Fix |
| --- | --- | --- |
| Symlinks | Delete, rename, stage, discard, and the model delete tool canonicalized the path, so deleting `CLAUDE.md -> AGENTS.md` deleted `AGENTS.md`, and discarding an untracked link to a directory ran `remove_dir_all` on the real directory. | `security::assert_entry_inside_workspace` resolves only the parent. Lifecycle and Git actions act on the link itself. |
| Git status | The porcelain v2 parser split on whitespace: renames became `"new old"`, `my file.txt` became `my`, and non-ASCII names came back C-quoted. Stage and discard then targeted the wrong path. | `-z` output with field-count `splitn`, and NUL-separated numstat. |
| Subfolder workspaces | Status paths were repo-relative, but the UI resolves them against the workspace folder. In a monorepo subfolder, stage, discard, and decorations failed. | Paths are made workspace-relative; numstat and the main comparison use `--relative`. The cache is keyed per workspace root. |
| Context index | A reader holding a stale log length took another reader's newer offset for a truncated log and wiped the index. The test saw 9 of 60 goal events survive. | Compare against the current log length. Indexing runs in an immediate transaction. |
| Chat workspaces | A projectless chat's private `sessions/workspaces/<id>` was never removed when the chat was deleted. | `GyroPaths::remove_chat_workspace` removes it. It refuses symlinks and anything outside the data root. |

## Stability fixes

- **Chats that could not open or send.**
  - The recent-event reader returned an error when 400 or 1000 events did not fit in 32 MB. Large command events make that realistic. It now returns the complete lines it read.
  - One corrupt JSONL line, or an event kind written by a newer app, made the whole chat unreadable. It is now skipped (`SessionEventKind::Unknown`).
  - One undecodable session row emptied the sidebar. The row is now skipped.
- **Launch.**
  - A database open, migration, or journal-recovery error aborted `setup` and the app never opened. These errors are now logged and startup continues.
  - Concurrent migrations (app and CLI) raced on `ALTER TABLE`. Migration now runs under `BEGIN IMMEDIATE` and treats a duplicate column as success. The connection pragmas retry on lock.
- **Panics.** `rateLimitType[..1]` on provider data could panic the stream handler. It now splits on a character. A panic unwinding out of `run_command` can no longer leak the provider process group, because a drop guard now owns it.
- **Hangs.**
  - A blocked PTY write held the one terminal map lock, freezing every pane, Stop, and quit. Panes now have their own locks, and writes happen outside the map lock.
  - Terminal create no longer holds the lock while it runs `git rev-parse` and spawns.
  - `run_command` no longer joins reader threads forever when an escaped descendant keeps the pipes open.
  - The Anthropic usage poll's Keychain read is bounded at 30 s.
- **Stop.** Stop now works while Codex's app-server is still starting (`initialize`, `thread/start`, `thread/resume`). Those waits previously ran to a 24 h deadline.
- **Quit.**
  - Provider CLIs and task commands run in their own process groups and survived Gyro quitting. They are now tracked (`gyro_core::register_process_group`) and killed in the drain.
  - The drain runs once, in parallel, under a 2 s deadline.
  - Task runs are cancelled.
  - Debug sessions now pass `terminateDebuggee: true` for a launch.
  - The per-PID IPC socket is removed.
- **Research sub-agents** stop at 14 minutes, just before the caller's 15-minute IPC read timeout. Before, they kept running and spending after the caller had given up.
- **Language servers.**
  - Parallel acquires started duplicate rust-analyzers. Acquires for the same key now wait on one start.
  - Model queries ran against stale text after edits. A content hash now triggers `didChange`.
  - More than 32 notifications arriving before a response failed the request. They are now queued. DAP event bursts get the same treatment.
- **Provider frames.** A 256K-char cap cleared the line buffer mid-frame, so large capability results were silently dropped. The bound is now the largest bridge message (48 MiB), checked in O(1). A frame over that is skipped whole.
- **Activity timeline.** One oversize entry dropped the turn's whole timeline. Entries are now truncated at a character boundary, and batches are chunked to fit the limits.

## Speed fixes

- **Sending a message** no longer reads and parses the last 1000 log events, twice per turn, under the exclusive lock. The turn index is authoritative once a session has any rows. Fully legacy logs scan 64 lines, and scan errors no longer block the append.
- **"Load earlier"** keeps raw lines and parses only the cursor candidates and the returned page.
- **Git refresh** uses one shared deadline per detailed status, where a worst case of about 155 s was possible before. A cache hit spawns 2 Git processes instead of 3–4; the main-branch stamp comes from ref file metadata.
- **Background Git reads** set `GIT_OPTIONAL_LOCKS=0`. The per-turn workspace check could otherwise take `index.lock` and break the agent's own `git commit`.
- **Workspace watcher:**
  - It ignores dependency and tool-cache churn at any depth (`node_modules`, `.venv`, `__pycache__`, …). Before, each `pnpm install` or test run triggered a rescan plus a full Git status.
  - It emits at least once every 8 rounds under constant churn.
  - Cache eviction no longer drops the watcher of a quiet, watched workspace.
- **Tree walk and search:**
  - One unreadable folder no longer fails the whole listing or search fallback.
  - Ripgrep caps matches per file, and output past the cap keeps the partial results instead of dropping to the slow WalkDir fallback.
- **Minified-file reads** no longer index every character of the file (about 512 MB for 64 MB of text) before truncating.
- **Store pool.** Warm-up opens connections outside the pool lock, and the pool holds 8 connections instead of 4. Launch no longer runs index maintenance twice.
- **Process termination** returns as soon as the group is gone, instead of always sleeping 250 ms. Every ACP turn and health check paid that delay.

## Behavior changes to know

- **Chat deletion:** deleting a *projectless* chat now deletes its private scratch folder (`~/Library/Application Support/Gyro/sessions/workspaces/<id>`). Files the agent wrote there go with the chat.
- **Subfolder workspaces:** a subfolder workspace's Source Control lists only files inside that folder. Files outside it could not be staged or reviewed there anyway.
- **Terminal review:** terminal-pane review now resolves paths against the pane's folder (`App.tsx` `reviewTerminalChanges`).
- **Watcher contract:** changes inside `node_modules` and similar folders no longer trigger a Source Control refresh. The test `workspace_watcher_ignores_git_internals_and_dependency_churn` now pins this.
- **Stale editor text:** while a file has unsaved editor changes, a model code-navigation query briefly points the language server at the on-disk text. The editor's next change restores it.

## Structure

- The terminal process manager moved to `terminal_process.rs`, and `check-workbench-ui.mjs` now reads that file.
- `lib.rs` went from 31144 to about 30870 lines, under its 31217 ceiling.

## Verification

| Command | Result |
| --- | --- |
| `cargo test --workspace --offline` | core 431 passed (baseline 409); desktop 476 passed, 4 ignored (baseline 457); CLI and integration suites passed |
| `cargo check -p gyro-desktop -p gyro-cli --offline` | Passed; the 2 warnings predate this work |
| `node scripts/check-workbench-ui.mjs` | One new failure: the plan-mode checklist check. It covers `plan-mode.tsx`/`surfaces.tsx`, which were being edited outside this work during verification. |
| `node scripts/check-architecture-boundaries.mjs` | Fails only on `App.tsx`. It was already 20436 lines at `334688c` against a 20329 ceiling; this work reduced it by 2. |

Several fixes were confirmed to fail without the change: the escaped-descendant join, migration race, context-index race, and index-lock tests.

## Not done / follow-ups

- `crates/gyro-cli/src/codex_app_server.rs` has its own process-group helpers, so it doesn't get the fast termination or quit tracking.
- `ensure_core_tables` creates `idx_sessions_provider_id` before the migration that adds `provider_id`. A database old enough to lack that column would fail to open.
- `source_control_review` caches `%ar` relative dates, which go stale on cache hits. Fixing it needs frontend date formatting.
- `create_terminal_pane` and `list_active_capability_resources` still do blocking work on a Tokio worker.
- Pending approvals re-read config from disk every 250 ms.
- The database grows without limit: resolved mutation proposals keep their file bodies, there is no `auto_vacuum`, and turn-index tables are never pruned. That needs a retention decision.
- No live-provider or native-app runtime measurement was taken. Latency claims above rest on code paths and tests, not a before/after benchmark (see `performance-contract.md`).
