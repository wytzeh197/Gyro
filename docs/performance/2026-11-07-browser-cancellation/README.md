# Browser cancellation and edit outcomes — 2026-11-07

The rebuilt Gyro debug app passed 19 native browser acceptance steps. In the
controlled cancellation case, `call_agent` returned **5.497 ms after Stop** and
the queued click did not change the page. This is one local measurement of a
browser callback boundary, not end-to-end provider Stop latency.

Raw results: [browser-cancellation.json](browser-cancellation.json),
[browser-smoke.json](browser-smoke.json), and
[validation.json](validation.json).

## Changes

- Model browser callback waits now observe their owning run's cancellation token
  and the captured workflow cancellation flag. The wait checks at intervals of
  at most 25 ms without creating another watchdog thread for each callback.
- Queued native main-thread work checks cancellation, expiry, and caller
  abandonment before starting. Late results cannot turn an already cancelled
  wait into success. Cancellation does not transfer to manual calls or the next
  run in that worker thread.
- Callbacks retain an eight-second individual timeout and share a fifteen-second
  waiting budget within one model browser tool. Previously each callback could
  wait eight seconds independently and ignored Stop. The old eight seconds is
  a source timeout bound, not a before-runtime measurement.
- Pointer-decoration cleanup is queued without a model wait. Cancelling a
  screenshot therefore does not leave pointer feedback hidden or extend Stop
  by waiting for a cleanup callback.
- Edit results explicitly report `applied` and `approvalRequired` from the
  durable proposal status. A pending proposal says that disk content is
  unchanged, retains its ID, and tells the model to await review before verifying
  that edit. Independent work can continue. Review policy is unchanged.

An action already submitted to WebKit or the operating system is not rolled
back. The queue test covers work that has not reached the native webview yet.
The shared budget bounds callback waits, not all filesystem or provider work.

## Verification

- 17 desktop browser tests passed, including six cancellation/wait tests for
  silent callbacks, queued work, late results, disconnection, budget sharing,
  thread isolation, and owner restoration.
- 13 workspace-edit tests passed. The durable-outcome test checks both pending
  and applied proposals, bounded output, and actual disk content.
- The workflow ownership test passed: a captured Stop flag remains bound to its
  workflow after the originating thread-local scope ends.
- Native acceptance passed 19 steps: cancelled queued click, repeat reads and
  stable refs, label lookup, invalid-select rejection, form entry/submission,
  pointer feedback cleanup, hidden browser interaction, viewport changes,
  screenshots, console/network observations, navigation/history, and close.
- Command-blocking, provider stream ordering, browser capability/pointer,
  observation cost, provider capability manifest, and workspace edit checks
  passed. The debug build, formatting, and whitespace checks passed.

The native cancellation test stalls the test app's main queue, schedules a click,
then cancels its owning operation. It releases the queue after the worker
returns and checks that the page still reports `Clicks: 0`. This verifies the
actual `call_agent` dispatch path rather than only a channel helper.

Reproduce after building the current debug app:

```sh
GYRO_NATIVE_SMOKE_APP="$PWD/target/debug/gyro-desktop" \
GYRO_NATIVE_SMOKE_SKIP_LSP=1 GYRO_BROWSER_SMOKE_SKIP_MOUSE=1 \
GYRO_NATIVE_SMOKE_KEEP_DATA=1 node scripts/run-native-smoke.mjs
```

The runner prints the disposable evidence directory. Native OS mouse input was
explicitly skipped; this run did not check Accessibility permission. The raw
smoke log's generic skip message should not be treated as a permission probe.
Language servers, a packaged release, and a clean-machine installation were not
tested. No model calls were made in this pass.

## Remaining goal work

The live GPT/Grok task matrix still needs a fixture review step and post-repair
acceptance. Native provider process draining, startup/first-token latency, tool
discovery overhead, and browser resource replacement while callbacks are in
flight still need investigation. The local browser result does not establish
the broader “best” claim or completion of the optimization goal.
