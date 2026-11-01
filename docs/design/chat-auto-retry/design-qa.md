# Chat recovery QA

Verified on 2026-10-12 with the production `ChatRun` fixture and invented turn
data. The recovery notice uses neutral surface/border/text tokens in both
themes, a compact host-deadline countdown, and existing Retry / Reconnect
actions. Temporary recovery is announced politely; countdown seconds are
excluded from live announcements.

## Browser checks

`node scripts/run-chat-retry-browser.mjs` passed with no browser exceptions.
Checks cover dark/light at 1440×900 and 860×620; default, small, and large
interface sizes; comfortable/compact density; a custom accent; and a 360px chat
pane. The narrow-pane check initially found squeezed copy; container-width
wrapping now keeps the copy readable and the controls below it with no overflow.

The runner verified the initial 30s countdown and its ticking deadline; Cancel
removing the schedule while keeping manual Retry; keyboard focus and manual
retry; Retry now cancelling the schedule and dispatching once; automatic
dispatch once at the deadline; permanent authentication recovery with Sign in;
and interrupted-turn recovery. Computed styles and geometry are recorded in
[browser-qa.json](./browser-qa.json).

The native fixtures mount the full `ChatSurface` with active status metadata,
recorded commands/files, and a pending approval. Browser checks verify that a
native wait remains a live retry state, uses the real 30s deadline, exposes only
Cancel, and creates no host retry schedule. Cancel forwards `cancel-retry` with
the owning status event and stops the wait without resending. Native resumption
clears the notice, retains tool work and the actionable approval, and shows the
final reply when the turn completes. Exhausted capacity retains the backend's
3-attempt explanation and manual Retry without a countdown. Light/dark narrow
native notices also pass the overflow checks.

The displayed countdown starts at 30s and was observed ticking for 2.2s. The
automatic-dispatch fixture uses a 3s deadline to keep that interaction check
short; host checks verify the production delay separately.

## Screenshots

- [Scheduled, light](./scheduled-light.png) and [dark](./scheduled-dark.png)
- [860px light](./scheduled-light-860.png) and [dark](./scheduled-dark-860.png)
- [360px pane, large/compact light](./scheduled-light-narrow-large-compact.png)
  and [dark](./scheduled-dark-narrow-large-compact.png)
- [Small/compact](./scheduled-light-small-compact.png)
- [Cancelled](./cancelled-light.png) and [keyboard focus](./cancelled-keyboard-focus.png)
- [Retrying](./retrying-dark.png), [permanent authentication failure](./permanent-dark.png),
  [interrupted](./interrupted-light-860.png), and [done](./done-light.png)
- [Native wait](./native-wait-light.png), [light narrow](./native-wait-light-narrow-large-compact.png),
  [dark narrow](./native-wait-dark-narrow-large-compact.png), and [native cancel](./native-cancelled-light.png)
- [Native resumed](./native-resumed-dark.png), [final reply](./native-done-dark.png),
  and [exhausted attempts](./native-exhausted-light.png)

## Automated checks and limits

- Retry policy checks passed: actual 30s deadline, one attempt per turn,
  historical-session loading, status-id migration, cancellation, busy sessions,
  newer turns, and exclusions for work/answers/permanent errors.
- Hook checks passed: dispatch at 30s, cleanup, cancellation, busy-session
  deferral, no repeated send, background plan isolation, and cancellation before
  an upload await. A retry preserves the session, attachments, goal, plan, and
  current draft through the existing replay path.
- Desktop TypeScript check and focused UI TypeScript check passed. Earlier
  unrelated chat-drag diagnostics were resolved by concurrent work.
- UI token check and existing chat run/network/message-queue checks passed.
- Rust test `model_availability_is_distinct_from_a_turn_output_budget` passed
  (1 test, 624 filtered).
- Follow-up native recovery validation passed: 7 recovery tests, 9 error
  classifier tests, and 6 existing replay/cancellation regressions. Capacity
  recovery waits 30s and continues an acknowledged Codex/Claude conversation
  for at most 3 automatic attempts. Completed activity history survives, child
  tasks remain active during the wait, and cancellation prevents dispatch.
- Retry dispatch regressions passed: duplicate clicks, original invoke and
  queue cleanup, new-message/Stop cancellation, independent background chats,
  and long transcripts where the original user event has left the 400-event
  window. A retry retains the original turn instead of entering the send queue.
- Native stream checks passed: deadline projection, preservation across disk
  refresh with an empty optimistic buffer, heartbeat handling, resume/terminal
  cleanup, and exhaustion classification before disk refresh. Host workspace
  and diagnostic metadata no longer incorrectly block a safe initial retry.
- Native retry helpers were extracted to their own module; `lib.rs` is 31,106
  lines, below its 31,217-line architecture ceiling.
- Full `pnpm test` progressed through startup/reliability checks, then stopped
  at the existing `surfaces.tsx` architecture ceiling. The file was already over
  its 29,926-line ceiling before this task; this feature adds recovery metadata
  parsing and wiring there.
- `pnpm smoke:workbench` still reports the existing Environment-popover layout
  and companion-dock assertions. Those surfaces were outside this change.

Cropped result previews: [light](./preview-light.png) and [dark](./preview-dark.png).

## Evidence limits

The fixture mounts production ChatRun and ChatSurface with invented events and
local host/native lifecycle simulations. The hook test executes production scheduling against a controlled
clock, and the Rust test validates provider recovery classification. No live
provider requests, paid retries, local app installation, or native WebKit
acceptance run were performed.
