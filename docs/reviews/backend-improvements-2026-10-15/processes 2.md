# Backend process reliability — 2026-10-15

Two failures were reproduced against the original production paths with owned local subprocesses, then fixed. No user terminal, live provider, installed application, or external service was used for these regressions.

## Cancellation and deadlines during continuous output

`crates/gyro-core/src/execution.rs` previously drained the output channel until it became empty before checking cancellation or timeout. A continuously writing process could refill it faster than the output callback consumed events. Stop and timeout then waited for the output budget, and the result was incorrectly classified as `OutputLimit`.

The regression launches `/usr/bin/yes`, uses a finite 2 MiB output budget as its safety stop, and performs 5 ms of simulated parsing/persistence work per callback. One test cancels from the first callback; the other sets an 80 ms timeout.

| Fixture | Before | After |
| --- | --- | --- |
| Cancellation | `OutputLimit`, 1,814 ms total and stop-to-return, 256 callbacks | `Cancelled`, 955 ms total, 954 ms stop-to-return, 138 callbacks |
| 80 ms timeout | `OutputLimit`, 1,821 ms total, 1,741 ms past deadline, 256 callbacks | `TimedOut`, 1,028 ms total, 948 ms past deadline, 149 callbacks |

These are local regression timings, not a product benchmark or a promise that cancellation returns instantly. Buffered events still run through the existing callback after teardown so already-read output is preserved. The bounded channel and reader/pipe buffers account for the remaining callback work.

The final production change checks cancellation and the runtime deadline between output chunks. It preserves the original normal-output draining and process-exit behavior. A peer-reviewed batch ceiling was removed before final verification because it would have moved finite output into the separate post-exit drain unnecessarily.

Additional finite-output coverage emits 256 KiB with a 160 KiB budget and a slow callback: it correctly returns `OutputLimit`, streams no more than 163,840 bytes, and completed in 136 ms in the final focused run.

Commands:

```text
CARGO_INCREMENTAL=0 cargo test -p gyro-core continuously_refills -- --nocapture --test-threads=1
  Before: 2 failed, both incorrectly returned OutputLimit.

CARGO_INCREMENTAL=0 cargo test -p gyro-core execution::tests -- --nocapture --test-threads=1
  After: 20 passed, 0 failed; 3.48 seconds.
```

Existing coverage also passed for output budgets, Unicode boundaries, retained partial output, process-group cleanup, escaped descendants holding pipes, finite stdin, and callback panic cleanup. The expected panic is caught by its regression test.

## Background PTY jobs after their shell exits

`apps/desktop/src-tauri/src/terminal_process.rs` marked a terminal settled as soon as its direct child exited. Its Stop, Close, and Drop cleanup then returned early, leaving background jobs in that shell's process group alive and able to hold the PTY open.

The regression starts an owned `/bin/sh` in a real PTY. It spawns a `sleep 30` background child that ignores HUP and TERM, writes the PID to a temporary file, and exits successfully. A cleanup guard kills the fixture process group even if the test fails. The assertion checks for child exit immediately after the pane reports completion, before Close.

- Before: `terminal background descendant survived observed exit: true`; the test failed after 3.02 seconds and its guard cleaned up the child.
- After: `terminal background descendant survived observed exit: false`; the test passes while preserving pane status `done` and exit code `0`.

The existing foreground/shell group teardown now runs when the direct child's exit is first observed, before the pane is marked settled. A known exit code skips portable-pty's direct PID signal against an already-reaped child. Groups that no longer exist do not incur the 25 ms escalation delay. The existing `terminated` guard still prevents repeat teardown. Descendants that deliberately escape both owned process groups are outside this change.

Commands:

```text
CARGO_INCREMENTAL=0 cargo test -p gyro-desktop --lib completed_terminal_stops_descendants -- --nocapture --test-threads=1
  Before: 1 failed, background child remained alive.

CARGO_INCREMENTAL=0 cargo test -p gyro-desktop --lib terminal_ -- --nocapture --test-threads=1
  After: 34 passed, 0 failed; 5.36 seconds.
```

The broader terminal filter also verified blocked-paste isolation, stop/close/restart, foreground job detection, output buffering, cancellation of terminal waits without killing commands, completion output, interactive zsh, and working-directory behavior.

Scoped Rust formatting and `git diff --check` passed. These are native process-level Rust tests; installed-app and live-provider acceptance are not claimed.
