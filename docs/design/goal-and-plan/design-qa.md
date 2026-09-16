# Goal and plan QA — 2026-09-16

## Result

Shared outcome controls render above Document and Steps. The thread keeps a compact
steps summary. Goal completion and checklist completion remain independent.
Plan/Council mode changes retain saved and pending goals and pass the goal into
the outgoing request.

## Automated checks

Passed after the final implementation changes:

- `CI=1 pnpm typecheck` (UI and desktop).
- `node scripts/check-ui-tokens.mjs`.
- `node --experimental-strip-types scripts/check-workbench-ui.mjs`.
- `node scripts/check-plan-document.mjs`.
- `node scripts/check-goal-plan.mjs`: executes the actual mode-change callback
  with isolated native/browser adapters for new/existing chats, and checks outgoing
  goal selection in all three modes.
- `git diff --check`.

The broad workbench checks are source/reducer guards, not screenshot tests.

## Browser evidence

Used Gyro Browser at `http://127.0.0.1:1420/goal-plan-fixture.html`.
The fixture mounts the production ChatSurface with seeded data and local callbacks.
Captured and visually inspected the delivered PNG images at 1039 × 941:

| View | Dark | Light |
| --- | --- | --- |
| Document | [Dark document](dark-document.png) | [Light document](light-document.png) |
| Steps | [Dark steps](dark-steps.png) | [Light steps](light-steps.png) |

Observed interactions:

- Document → Steps → Document retains the goal.
- Editing the goal in Document updates both the rail and thread text.
- Complete changes the control to Reopen; Reopen restores Complete.
- Explicitly blocking a working step changes the blocked count from one to two;
  unblocking restores Working and the count to one.
- All four step marks have readable words. Both palettes distinguish working,
  completed and blocked.
- Fixed document content being pushed to the bottom by the old two-row grid.
- Fixed clipped status words caused by actions consuming an extra grid slot.
- Added a separate grid row for the hoisted goal in the checklist rail.

## Evidence limits

This is component rendering and interaction evidence, not a live provider run,
native persistence check, or performance measurement. The 620px action-wrap and
reduced-motion rules were inspected in source; they were not exercised through
viewport/media emulation. The browser screenshot mobile option retained the
1039px viewport, so it is not counted as mobile evidence.

The console included an unhandled notification permission ACL rejection
(`plugin:notification|is_permission_granted`) alongside Vite connection/HMR
messages. The tested goal/plan interactions completed; that host notification
permission issue is outside this change.

Changes remain uncommitted and include pre-existing workspace work.
