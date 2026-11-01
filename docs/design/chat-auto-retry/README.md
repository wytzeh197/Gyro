# Calm chat recovery

## Problem

Temporary model capacity failures currently look like an urgent, destructive
error. The chat should explain the pause calmly and make a scheduled retry easy
to understand and control.

## Placement

The notice stays in its turn, below the work timeline, using the existing
`ChatRun` / `RunProblem` recovery surface. Retry and reconnect keep their existing
host actions and conversation context.

## States

| State              | Trigger                                                    | Presentation                                                                                                                                      |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled          | Host schedules one automatic retry for a temporary failure | Neutral “Waiting to retry” header, “Model is temporarily busy”, deadline countdown, Retry now and Cancel                                          |
| Cancelled schedule | User cancels automatic retry                               | Same calm notice with manual Retry; no ticking timer                                                                                              |
| Retrying           | Host begins the next send                                  | Existing live run states take over; recovery notice disappears                                                                                    |
| Native wait        | Capacity is reached after work in a live turn              | Keep the existing invoke and child tasks alive; show Waiting to retry, recorded-work explanation, a real deadline, attempt limit, and Cancel only |
| Native resumed     | Native retry-started arrives                               | Remove the wait notice and continue the same work timeline and approvals                                                                          |
| Native exhausted   | The bounded continuation attempts are exhausted            | Retain the provider's explanation and recorded work, with manual Retry and no countdown                                                           |
| Permanent failure  | Retry cannot resolve the failure                           | Neutral factual notice, manual actions where supported, alert announcement                                                                        |
| Interrupted        | Gyro loses the unfinished turn                             | Existing interruption explanation and manual Retry                                                                                                |
| Stopped            | User stops the send                                        | Existing neutral Stopped header; no error notice                                                                                                  |
| Recovered          | Retry completes                                            | Existing response and settled work timeline                                                                                                       |

## Composition and visual spec

Reuse `gyro-run-problem`, its text/actions, and `gyro-run-header`. A focused
`chat-recovery.css` module replaces the red fill/border with
`--gyro-surface-soft` / `--gyro-border-soft`, uses `--gyro-text` and
`--gyro-muted`, and keeps compact controls with `--gyro-control-standard`,
`--gyro-radius-sm`, and `--gyro-font-support`. The notice uses
`--gyro-radius-md`, standard/comfortable spacing, and no shadow or animation.
The countdown is a small text label beside the controls rather than a separate
banner or progress bar. On narrow widths the controls wrap below the copy.

## Data honesty

`ChatRetryContext.pending[eventId].retryAt` is the real host deadline. Remaining
seconds are `ceil((retryAt - Date.now()) / 1000)`, never a restarted local timer.
UI does not schedule provider calls. Each initial failed send gets at most one
host-scheduled automatic attempt; Cancel and Retry now cancel that attempt
before any manual send. A native capacity wait inside an active invoke uses
the provider status's `nativeRetry`, RFC3339 `retryAt`, `retryAttempt`, and
`retryMaxAttempts`. A valid native deadline takes precedence over transport
reconnect display and creates no host schedule. Native Cancel stops the existing
invoke through the owning status event. The native attempt limit comes from the
backend rather than a second UI retry loop.

## Copy and accessibility

Capacity/overload: “Model is temporarily busy”. Scheduled detail: “The
conversation context is preserved.” Countdown: “Retrying in 30s”; at the
deadline: “Retrying…”. Controls: “Retry now”, “Cancel”; once cancelled, “Retry”.
Temporary recovery uses a polite status region. The changing seconds are hidden
from live announcements; a stable description says an automatic retry is
scheduled. Permanent errors retain an alert with factual detail. All controls
remain keyboard operable and use the shared visible focus token.

Native waiting detail: “Recorded work and active tasks are preserved. Retry 1 of
3.” Native wait exposes only Cancel; the same live run takes over on
retry-started. An exhausted capacity failure says “Model is still busy” and keeps
the backend's explanation and manual actions.

## Evidence

`apps/desktop/chat-retry-fixture.html` mounts production `ChatRun` with invented
turn data. It supports scheduled, cancelled, permanent, interrupted, retrying,
and done states plus dark/light themes, density, interface size, and a narrow
layout. Fixture interactions exercise local Cancel / Retry callbacks. Real
provider scheduling and native persistence require host checks.

The `native-wait`, `native-resumed`, `native-cancelled`, `native-exhausted`, and
`native-done` states mount the full production `ChatSurface`, including status
metadata parsing, recorded commands/files, an approval, and a final reply.

## Out of scope

Automatic provider/model switching, infinite retry loops, and retrying
authentication, permissions, cancellation, or unavailable-model failures.
