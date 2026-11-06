# Provider cooldown correction

The desktop CLI retry loop treated a provider's cooldown above 30 seconds as if
no cooldown had been supplied. A rate-limit error saying `retry after 90 seconds`
therefore restarted the runner three times, after approximately 400 ms, 1.2 s,
and 3 s. Model-capacity retries also ignored explicit cooldowns. Millisecond
durations were interpreted as seconds, and extreme numeric values could panic
the parser through integer overflow.

The existing public `retry_after_hint` helper remains available. The desktop
retry decision now distinguishes a missing hint from an unsupported or excessive
cooldown. Missing hints retain the existing fallback, supported durations up to
30 seconds use the provider's delay, and unsupported or longer hints return the
original provider error without dispatching another run. Parsing uses bounded
integer arithmetic, preserves milliseconds and fractional units, and rounds up
fractional milliseconds. The visible-output and native-cursor replay guards are
unchanged.

## Regression evidence

Before changing production code:

- `CARGO_INCREMENTAL=0 cargo test -p gyro-core provider_retry::tests::cooldown_ -- --nocapture`
  failed both new tests: `500ms` returned `None` instead of 500 ms, and
  `18446744073709551615.1 seconds` panicked with `attempt to add with overflow`.
- `CARGO_INCREMENTAL=0 cargo test -p gyro-desktop provider_retry_recovery::tests::provider_cooldown_beyond_automatic_wait_does_not_restart_the_runner --lib -- --nocapture`
  failed because `HTTP 429: retry after 90 seconds` dispatched four runs instead
  of the expected one.

After the final parser and recovery changes:

- `CARGO_INCREMENTAL=0 cargo test -p gyro-core provider_retry -- --nocapture`
  passed all 15 retry/stream tests, including millisecond and fractional-unit
  parsing, punctuation, overflow, unknown units, absent versus unusable hints,
  bounded HTTP retries, shared retry budgets, cancellation, and visible-output
  replay protection.
- `CARGO_INCREMENTAL=0 cargo test -p gyro-desktop provider_retry_recovery::tests --lib -- --nocapture`
  passed all 9 recovery tests. Long provider cooldowns dispatch one run and no
  waits; short cooldowns select the exact delay. Existing cancellation,
  completed-work, durable-cursor, and unsupported-provider replay guards pass.
- `rustfmt --edition 2021 --check crates/gyro-core/src/provider_retry.rs apps/desktop/src-tauri/src/provider_retry_recovery.rs`
  and the scoped `git diff --check` passed.

These tests use fake runner callbacks and temporary local session stores. They
make no live provider requests and spend no account quota. Installed macOS app
acceptance is outside this verification.
