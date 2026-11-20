# Terminal surface fixes — 17 November 2026

Implemented after approval of the terminal audit. These are source changes, not an installed or released app. Concurrent chat, editor, review and Cloud-agent work was preserved.

## Changes

- Fit xterm inside an unpadded mount, with space reserved for the model notice and recovery footer. Restore the native scrollback scrollbar.
- Clicking failed output only focuses/selects it. Restart requires an explicit action. Keyboard focus on the outer host reaches xterm input.
- Reserve pending launches before the Tauri worker starts. Close, replacement and quit invalidate reservations; cancelled launches cannot insert a late process. Cancellation does not trigger an ungoverned fallback launch. Failed close requests retain the pane unless its process is already missing.
- Save successful PTY dimensions into the restart request. The renderer acknowledges successful resize calls, retries failures and resends size for a new process generation.
- Decode UTF-8 incrementally, preserving incomplete characters across reads. Retry interrupted reads and handle reader-thread creation failure without abandoning the child.
- Identify output by process generation and normalized UTF-8 byte positions. Local reads can return deltas; repeated rolling windows no longer discard new output. Keep polling exited processes until their reader has drained.
- Poll visible terminals every 100 ms, including while chat is generating; poll background panes at 1 s and catch up on visibility/focus. Requests remain limited to one in flight per pane.
- Use `zsh -ilc` for terminal command overrides and augment PATH for absolute executable paths as well as bare commands.
- Route Cmd+K to terminal clear when terminal input owns focus. Preserve global search elsewhere.

## Verification

| Check | Result and boundary |
| --- | --- |
| Production renderer browser fixture | Pass: normal/narrow geometry, larger text, light/dark themes, model notice, reveal, restart, initial resize retries, typing, Ctrl+C bytes, bracketed Unicode paste, focus, stopped-process input suppression, explicit restart, recovery footer and contextual clear. This is Chromium fixture evidence, not WKWebView acceptance. |
| Native PTY manager tests | 11 passed using the production `terminal_process.rs` and `terminal/types.rs` in an isolated Rust harness. Includes foreground Ctrl+C, cancelled launch, preserved restart size, output generations/deltas, split UTF-8, descendant cleanup, stalled-write isolation and parallel shutdown. Unrelated app/governance/sandbox dependencies were stubbed; this does not verify Tauri IPC or sandbox behavior. |
| Terminal-focused TypeScript | Pass, including terminal renderer, output helpers, shortcut helper, fixture, app-state and imported UI code, using the desktop compiler options and existing ambient declarations. |
| Existing regression scripts | Terminal output/layout/launch selection/profiles/failure, native shortcut routing, chat browser shortcut routing, remote client checks and UI token checks passed. |
| Full desktop TypeScript | Not clean during concurrent edits: errors were reported in chat-session updates, mutation approval and remote review, outside this terminal patch. |
| Full Rust desktop build | Stopped when free disk space fell below 5 GB during concurrent builds. The smaller native PTY harness completed instead. |
| Whitespace | `git diff --check` passed. |

Browser geometry before the fix: a 983 × 560 terminal grid was clipped into 968 × 549 visible pixels. Afterward, the fitted grid is 954 × 544 inside that visible area. The model notice now reduces the terminal's available height rather than pushing it outside the frame.

Fixture captures: [normal terminal](screenshots/terminal-surface-2026-11-17/terminal-frame.png), [model notice](screenshots/terminal-surface-2026-11-17/model-notice.png), [small pane / large text](screenshots/terminal-surface-2026-11-17/small-pane-large-text.png), [failed process](screenshots/terminal-surface-2026-11-17/failed-process.png). The fixture explicitly redraws its test TUI at reported dimensions because it has no child receiving SIGWINCH.

## Design review

- Pass: existing terminal palette, typography, components and semantic spacing retained; UI token budget passes.
- Pass: populated, model-owned and failed states checked; status and recovery labels derive from pane state. Empty/launcher states were not changed or re-exercised.
- Pass: recovery controls stay outside output; no additional primary action hierarchy was introduced.
- Pass: terminal input focus, preserved outside-field focus and contextual keyboard behavior checked in the fixture.
- Unverified: native WKWebView rendering, physical sleep/wake, OS clipboard integration, sustained 32-terminal load and live Claude/Codex sessions.

Rerun the browser suite with a local desktop Vite server:

```sh
GYRO_TEST_ORIGIN=http://127.0.0.1:1447 node scripts/check-terminal-renderer-browser.mjs
node --experimental-strip-types scripts/check-terminal-output.mjs
cargo test -p gyro-desktop --lib terminal_process::tests --locked
```

The last command is the normal full-project path for the Rust tests and still needs completion once build resources permit. No installation, commit or push was performed.
