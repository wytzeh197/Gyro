# Backend goal runner

Normal composer chats with an active goal now have a backend supervisor. It owns the provider slot and kernel session lease until the goal finishes, pauses, or becomes blocked. The frontend does not send continuation messages on a timer.

## Turn lifecycle

Each response saves a normalized `GYRO_GOAL_UPDATE` checkpoint. `continue` requires verified progress and a concrete next action; `complete`, `blocked`, and `paused` stop scheduling. Questions, cut-off answers, user cancellation, repeated checkpoints, and missing reports also stop the run. A missing report gets one bounded continuation to supply a checkpoint.

Automatic turns have new turn IDs and reuse the existing compatible provider session. Intermediate answers and goal events arrive in the chat while the original invocation stays open. The message queue remains owned until the backend releases the run. Permission flags and model choice stay attached to the request; original attachments and workspace snapshots are not resent.

## Limits

The defaults are **8 automatic turns after the initial turn, 120 minutes, and 500,000 new input/output tokens**. Cached input is excluded from the new-token ceiling. Existing provider usage guards still apply. The time watchdog and live token guard can stop an in-flight call.

The backend goal-change endpoint accepts `runLimits` alongside the existing goal payload:

```json
{"action":"set","text":"Finish verification","status":"active","runLimits":{"maxAutomaticTurns":4,"maxMinutes":30,"maxNewTokens":50000}}
```

Limits are validated and saved per goal. A user-initiated new run receives a fresh allowance; restart recovery retains the queued run's deadline and counters.

## Recovery and user control

Queued requests are durable goal events. Startup may resume only a matching queued request with no recorded provider attempt, within its original limits, after acquiring the session lease. Recovery requires command and file approvals and disables unattended full access.

An interrupted running turn pauses with its checkpoint instead of replaying uncertain actions. Pause stops the provider and further scheduling. Resume starts from the saved checkpoint. Goal events carry the goal's revision, so late model and runner events cannot revive a cleared goal or complete a reopened one.

The goal strip distinguishes running, queued, waiting for approval, blocked, paused, and completed states, and shows a stop reason. Planning, Council, automations, and delegated agents keep their existing lifecycles.

## Verification

Focused Rust tests cover checkpoints, limits, cancellation/watchdogs, store reopen, queue recovery, session leases, and stale goal revisions. `scripts/check-goal-runner.mjs` covers approval states, intermediate response delivery, and frontend queue ownership. The standalone `goal-plan-fixture.html?panel=none` renders the actual goal controls without native IPC.

These checks establish source and fixture behavior. Live provider continuation and installed-app restart acceptance remain separate checks.
