# Moving turn orchestration into gyro-core

Goal: `gyro-desktop` becomes a Tauri shell (commands, events, window state), and
everything that decides *how a turn runs* lives in `gyro-core` behind host
traits, so `gyro-cli` and `gyro-remote` get the same behavior without copying it.

## Done

**Slice 1: retry and recovery loop** → `gyro_core::provider_runtime::recovery`

- Moved: the retry ladder, stale-cursor recovery, the no-replay checks,
  continuation requests, failed-attempt checkpointing, and the import-continuation
  checks.
- Desktop `providers/retry_recovery.rs` keeps only the Tauri pieces: the
  shared-cooldown wait, `cooldown_scope` (reads desktop config) and the
  `emit_*` retry events. The rest are re-exports under the old names, so callers
  and tests did not change.
- The host plugs in through two closures: `run_once` (one attempt) and `wait`
  (how a retry wait is shown). That is enough for this slice, so no new trait
  was needed.

## Next slices, in order

Each slice is one PR. It must keep desktop behavior identical, and existing
desktop tests must pass unchanged through re-exports.

1. **CLI uses the core retry loop.**
   - `gyro-cli/src/runner_host` runs a provider once and never retries.
   - Wrap that single call in `recovery::run_with_retry_and_wait` and print the
     waits.
   - This is a CLI behavior change, so it should be a decision rather than a side
     effect. The loop never replays work that has already been published.

2. **Provider accounting and spend guard.**
   - `provider_accounting.rs` and `provider_spend_guard.rs` mostly need
     `SessionStore`.
   - Define a small `AccountingSink` trait for what reaches the UI.

3. **Context compaction.**
   - `context_compaction.rs` mixes summarization policy with Tauri stream muting.
   - Move the policy. Keep `summary_stream_muted` as a host hook.

4. **State-manager traits.**
   - Calls like `app.state::<X>()` (run registry, stop flags, event sequence) are
     the main thing keeping `providers/run.rs` tied to Tauri.
   - Define `TurnHost` in core: stop status, next event sequence, emit event, and
     load config.
   - Implement it once for `tauri::AppHandle` and once for the CLI.
   - After that, `providers/run.rs` and `streaming` can move.

5. **Goal runner and delegated agents.**
   - These depend on step 4. They are the largest modules and are worth moving
     only once `TurnHost` exists.

6. **Cleanup that can happen at any time.**
   - Delete the cloud code paths that nothing uses:
     - `cloud_connection` v2, if v3 has fully replaced it;
     - the test-only `gyro_cloud.rs`.
   - Decide whether `services/gyro-cloud` or `services/cloud-agents` is the
     current one.
   - Move smoke and benchmark code (`performance_benchmark.rs`, smoke runners)
     out of the production crate into `#[cfg(test)]` or a dev binary.
   - Standardize on one HTTP client. ureq has 127 uses and reqwest has 12, so
     pick one for new code.

## Rules for every slice

- Moved code goes into core without changes. Desktop re-exports it under the
  old names, so callers and tests stay untouched in that PR.
- Remove the aliases afterwards, in a separate PR.
- Core never imports Tauri. If a function needs `AppHandle`, its core version
  takes a closure or a host trait instead.
- Run `cargo test -p gyro-core` and the desktop provider tests for every slice.
