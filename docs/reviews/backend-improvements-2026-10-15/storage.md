# Session history recovery — 2026-10-15

An interrupted event append ending inside a UTF-8 character made all three history readers fail: recent events, full transcript, and durable context. The existing recovery path handled incomplete ASCII JSON, but strict UTF-8 decoding failed before it could discard an unfinished multibyte record.

`crates/gyro-core/src/sessions.rs` now excludes the unfinished invalid tail before decoding recent history and treats an invalid unterminated line as end-of-log in sequential readers. Complete newline-terminated records still decode strictly. Valid complete events without a final newline remain readable. Reads do not modify the log; the existing append path repairs the unfinished record. Context indexing stops at the last complete record, so the subsequent repaired append is indexed correctly.

## Red/green evidence

Before the production fix, this command failed:

```sh
cargo test -p gyro-core --lib incomplete_utf8_tail_does_not_hide_durable_session_history -- --exact sessions::tests::incomplete_utf8_tail_does_not_hide_durable_session_history --nocapture
```

Result: **1 failed**. Recent, transcript, and context readers all returned `session event log is not valid UTF-8`, caused by an incomplete UTF-8 byte sequence.

After the fix:

```sh
CARGO_INCREMENTAL=0 cargo test -p gyro-core --lib sessions::tests:: -- --nocapture
```

Result: **54 passed, 0 failed**. This covers the interrupted multibyte tail, complete-record corruption rejection, valid events without final newlines, append repair, context index boundaries and resumed indexing, concurrency, pagination, and existing event-size limits. `git diff --check -- crates/gyro-core/src/sessions.rs` passed.

The recovery regression was subsequently strengthened to compare the entire interrupted file byte-for-byte after all recovery reads, replacing a durable-prefix-only comparison. That assertion passed in the final workspace run: 1,357 passed, 0 failed, 7 live-integration tests ignored. Every storage fixture uses a temporary directory; no user session store was opened.

## Independent execution review

Review of the initial `execution.rs` output-drain fix identified two finite-output regression risks from its 16-chunk main-loop bound: post-exit queued output could exceed the budget while retaining successful `Exited` status, or slow callbacks could move an ordinary backlog into the bounded post-exit drain and lose output.

The final change removes that batch ceiling and retains only the cancellation/deadline check between chunks. Independent re-review confirms that normal finite draining, output-limit handling, and existing termination precedence remain unchanged. The finite-producer output-budget regression is retained. This reviewer ran no process tests; see the process owner's evidence for their results.

This evidence establishes local backend behavior only. The installed macOS app has not been rebuilt or exercised for this change.
