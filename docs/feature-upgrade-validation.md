# Core workflow upgrades

Implemented on `release/v0.1.0-alpha.49.5`. No release version change.

## Delivered

- Post-edit review uses reading marks. Native edit approval remains in chat. Unattributed diff lines and counts are no longer manufactured. Historical review uses bounded UTF-8 patches captured with applied mutation receipts; missing patches have an explicit explanation and a separately labeled current comparison.
- Task creation collects title, prompt, project, provider/model, and local/worktree mode. A task owns a real session; saving does not send. Dispatch uses the normal chat path, including saved attachments. Cards group by project, open their sessions, derive activity from session events, and require explicit completion. Metadata is stored by session ID. Legacy cards require a real prompt for conversion.
- Keyboard context selection supports `@file` and `@open-tab`; editor snapshots include unsaved buffer content and use the existing preparation checks. Safe dock layout restores per pane; side-chat sessions remain transient.
- PR creation collects title, body, base, head, and draft. The checked-out branch's PR is included even outside the recent list. Refresh failures retain an explicit warning; review and merge continue in GitHub.
- Creating an automation records no run. Exact legacy creation receipts are hidden in the display without removing stored history. Real runs link to sessions. Editing preserves execution context/history and rejects active-run edits. Calendar schedules support once, daily, and weekly in an IANA time zone. Existing interval schedules retain their original semantics. Gyro must be running to execute work.

## Verification

- `CI=1 pnpm check`: passed.
- `cargo test --workspace`: 845 passed, 4 ignored. Socket-dependent tests required execution outside the restricted sandbox.
- Production frontend build: passed (existing large-chunk warning).
- Focused workflow, review scope, file review, dock, GitHub reliability, and source-control review scripts: passed.
- Automation tests cover empty initial history, unchanged legacy intervals, time-zone validation, spring/fall daylight-saving transitions, edit/history preservation, active-run edit rejection, and durable run/session links.
- Tracked-file name-removal check and `git diff --check`: passed.

## Native observations

Used a separately named QA bundle of this checkout, a disposable project, and isolated backend data.

- Created a task, observed its saved/unsent card, opened the linked chat, and verified its prompt.
- Selected a file with the keyboard through `@file` and observed the prepared attachment.
- Selected `@open-tab` and observed an immutable editor snapshot. This found and fixed an absolute-versus-relative path mismatch.
- Restarted with persistent QA storage; the card and unsent prompt were retained.
- Confirmed that a disconnected provider prevents sending.

Gyro's debug `GYRO_TEST_DATA_DIR` mode uses an incognito webview by default. For restart acceptance tests, `GYRO_TEST_PERSIST_UI=1` enables normal UI persistence; use a separate QA bundle identity. This does not change production behavior.

## Still unverified live

The isolated app had no connected provider. A full provider run → native approval → historical review round trip, a real scheduled provider execution, live GitHub PR creation/refresh failure, and native dock restoration were not completed. Receipt/migration/scheduling and dock restoration behavior are covered by automated checks. No PR, commit, push, or release was created.

## Scheduled-work design follow-up

The supplied screen recording informed the centered automation list, status filters,
suggestions, and split setup/detail view. Suggestions only populate an editable draft.
The setup panel shows actual project/provider context, workspace mode, and selected model;
runs remain local and require the app to be running. Existing interval schedules retain
explicit interval labels; new drafts default to daily wall-clock time with an IANA zone.

Backend regression coverage now includes editing completed one-time schedules without
losing history, rejecting reactivation of past one-time schedules, and rescheduling them
before resuming. Save/status errors expose the backend reason. The automation test suite
passes 13 tests; native QA checked overview, suggestion setup, and hidden-sidebar layout.
The isolated QA profile has no connected provider, so this pass did not execute a live
scheduled model run.

## Reliability and editable execution details

- Lease claims and their run receipts commit together. Editing, status changes,
  session linking, result completion, recovery, and history triage use write
  transactions to prevent stale snapshots from overwriting concurrent changes.
- Provider dispatch rechecks persisted status after registering cancellation;
  panic handling clears scheduler/session registrations. Late success preserves
  an explicit pause. Unowned completion cannot finish an active leased run.
- Regression tests cover competing schedulers, receipt-write rollback, paused
  completion, duplicate completion rejection, and history/session persistence
  across reopening the database.
- Automation setup and editing now offer a native project picker and workspace,
  provider, and model selectors. Execution settings persist alongside existing
  run history. Newly allocated automation worktrees use unique names.
- This Mac and a new chat per run remain the supported execution targets.
- The separate Tasks page and creation command were removed at the user's request;
  old page routes redirect to Automations, with existing sessions/data preserved.
