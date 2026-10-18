# Backend improvements — 2026-10-15

Scope: `/Users/wytze/Gyro`, branch `v0.1.0`, HEAD `ca28b906` plus the existing working-tree changes. This pass addresses reproducible backend failures. It does not install, publish, push, or call paid providers.

## Confirmed failures and changes

### Interrupted Unicode writes hid durable chat history

A JSONL append interrupted halfway through a multibyte character made recent history, full history, and durable context reads fail UTF-8 decoding, even though earlier events were intact. The regression failed in all three readers before the fix.

Readers now discard an unfinished invalid final record before decoding the durable records. Completed records still decode strictly, valid complete records without a final newline remain readable, and the context index stops at the durable byte boundary. Reads leave the file unchanged; the next append repairs the incomplete tail through the existing repair path.

Changed: `crates/gyro-core/src/sessions.rs`. Focused verification: all 54 session tests passed. Details: [storage.md](storage.md).

### Continuous command output starved cancellation and deadlines

The execution loop drained its output channel until empty before checking Stop, timeout, or child exit. A producer that kept refilling the channel could prevent these checks. Real `/usr/bin/yes` regressions with deliberately slow callbacks returned `OutputLimit` for both a cancelled command and an 80 ms timeout.

The loop now checks cancellation and deadline between chunks. It preserves the existing finite-output drain and queued output during bounded teardown. This improves observation of Stop and deadlines; callback work still contributes to return latency.

Changed: `crates/gyro-core/src/execution.rs`. Final verification and measured fixture timings: [processes.md](processes.md).

### Long provider cooldowns fell through to rapid retries

The CLI cooldown parser used the same `None` value for an absent hint and a hint above its 30-second automatic wait ceiling. Desktop recovery therefore replaced an explicit 90-second cooldown with its short retry ladder. The parser also mishandled milliseconds and could overflow on extreme numeric text.

The new retry decision distinguishes absent hints from explicit waits that exceed the automatic budget or cannot be interpreted safely. Long cooldowns leave the original error actionable without additional launches, including capacity errors. Milliseconds and fractions are parsed with bounded arithmetic and rounded upward. Existing retry budgets and visible-output replay guards are retained.

Changed: `crates/gyro-core/src/provider_retry.rs` and `apps/desktop/src-tauri/src/provider_retry_recovery.rs`. Changes and verification: [retries.md](retries.md).

### Completed terminal panes left background jobs running

Observing the shell's natural exit marked the terminal process as terminated before cleaning up its remaining jobs. Stop, Close, and Drop then skipped cleanup. A real PTY regression left a background child alive after the pane reported a successful exit.

The exit-observation path now invokes the existing process-group cleanup before marking the pane settled, preserving the shell's exit status. It skips signalling the already-reaped direct child and avoids the grace-period sleep when no process groups remain. The scope is the original shell group and current foreground group; deliberately detached descendants are outside this change.

Changed: `apps/desktop/src-tauri/src/terminal_process.rs`. Verification: [processes.md](processes.md).

## Verification

The combined command completed successfully:

```sh
CARGO_INCREMENTAL=0 cargo test --workspace --locked --no-fail-fast -- --test-threads=4
```

**1,357 passed, 0 failed, 7 ignored**, across 11 test targets. Breakdown: CLI units 40; CLI integration 25; macOS CLI install-path integration 1; core units 599; efficiency checkpoint 3; event compatibility 1; desktop units 688. Empty doc-test targets also passed. The seven ignored tests require live models, signed-in provider accounts, installed provider CLIs, or live model catalogs. They were not opted into for this pass.

The workspace run includes the strengthened storage assertion that recovery reads preserve the entire interrupted file byte-for-byte. Scoped `git diff --check` passed. Existing unused/dead-code compiler warnings remain; this report does not claim strict lint success.

Evidence: [full test log](workspace-tests.log), [verification summary and source hashes](verification.json), and the focused red/green reports above. Regressions use temporary stores, simulated provider results, and real local child processes. They do not establish live-provider or installed native-app acceptance. The installed application was not rebuilt or replaced.

All **43 previously modified tracked files** match their hashes captured before this backend pass in `initial-dirty-files.json`. Only the five listed backend source files and this evidence directory were changed by the backend work. Changes remain local and uncommitted.
