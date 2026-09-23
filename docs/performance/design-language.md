# Gyro visual language: a calm Mac workspace

Gyro's identifying element is a visible thread from request, through work, to an
inspectable result. It uses the existing graphite/porcelain surfaces and blue
accent. The design study retains sidebar modes, conversation position, bottom
composer, companion panel, and the right-hand tools rail.

## Foundation and hierarchy

- Use the system sans-serif stack from `--gyro-font-sans`; monospace is for code,
  commands, and paths where it aids reading. Body answers are 14px with 1.65 line
  height; controls and activity are 12–13px; secondary metadata is 11–12px.
- Align conversation prose and idle prompts left. Keep the readable conversation
  width near 760px. The surrounding workspace can widen without stretching prose.
- Use `--gyro-app`, `--gyro-sidebar`, and `--gyro-pane` for the three surfaces.
  Use soft borders between regions; avoid floating-card shadows in the conversation.
- Use a 4px spacing rhythm: 8px within controls, 12–16px within compact groups,
  24–32px between request, work, and result. Shared radius tokens distinguish small
  controls, grouped content, and the composer. Controls use consistent 28–32px
  compact heights, with explicit accessible labels.
- Blue indicates selection, focus, or the primary action. Additions remain green;
  deletions remain red. Verification and failure include words and symbols.

### Workspace panel rules

- Keep the existing graphite, porcelain, and blue palette. Use spacing and
  hierarchy to reduce bulk before reducing readable text size.
- A workspace AI chat needs at least 440px. Its Environment card takes a bounded
  row below the title when open, leaving the transcript and composer unobscured.
- Source Control starts at 360px so its branch and file names remain useful. It
  can still be resized; editor space remains the other priority.
- Keep the conversation's reading width near 760px in the full chat. Utility
  panels may take adjacent space only while the remaining conversation stays
  readable. At a narrow width, stack a utility above content within its pane.
- Review may fold its changed-file list into a single row so the diff has room
  to read. The list reopens in place without losing the selected file.
- Reopening Terminal or another ordinary workspace drawer after Browser focus
  or a near-full drawer restores a useful editor height. Resizing an open drawer
  remains an explicit way to give that tool more space.
- Explorer keeps source folders and root files first, then dotfile configuration,
  then known dependency and build output paths. These paths stay visible and
  keyboard reachable; children of each folder retain the usual directory-first
  order.
- Session titles stay on one line in the narrow rail. Truncated titles retain
  their full tooltip and accessible name; the timestamp keeps its own space.
- Appearance theme samples stay short enough that density and color controls
  remain in the first view. Provider rows show setup guidance when a connection
  needs action, while the model, connection state, and primary button carry the
  routine connected state.
- Large-file text diffs open with lines wrapped, and the toggle still allows
  horizontal scrolling when exact line layout matters. An empty editor uses a
  centered, single-line prompt that names the next file selection.

## The activity thread

A small state mark and restrained vertical line anchor the existing `ChatRun`.
The row names the state once. Read/edit/check groups keep tool details expandable.
The result exposes changed files and opens their review beside the conversation.
Verification has its own visible status in the companion panel.

| State     | Text                | Shape / behavior                                            |
| --------- | ------------------- | ----------------------------------------------------------- |
| Idle      | Ready               | No work/result claim; composer ready                        |
| Preparing | Preparing workspace | Quiet ring; workspace check explanation; Stop available     |
| Working   | Working             | Blue open ring; actual tool groups and streamed content     |
| Approval  | Awaiting approval   | Amber diamond; precise action, scope, Reject and Allow once |
| Stopped   | Stopped             | Neutral square; existing edits retained; no error alert     |
| Failed    | Needs attention     | Error mark and explicit cause; recovery action beside it    |
| Completed | Completed · elapsed | Checkmark; changed files and recorded verification          |

A heartbeat means the connection is alive. It does not add a work item, advance
a progress percentage, reset “last activity,” or assert that a tool completed.
The prototype's “Provider connected. Waiting for the next result” makes that
distinction explicit. A successful edit alone cannot produce the completed state.

## Interaction and motion

The composer stays editable during streaming. Stop cancels pending simulation
callbacks and preserves the draft and already visible result. Review stays on
the right; its divider supports pointer dragging and 20px arrow-key increments.
At narrow desktop sizes, the same regions remain usable with internal scrolling.
Below 780px the companion is hidden in this study; that is a fallback, not a
proposed change to desktop navigation.

Use 80ms background and 130ms border transitions for direct actions. Never delay
typing or streamed content for an entrance animation. `prefers-reduced-motion`
removes study animations and transitions. Focus uses the shared blue token and a
visible outline; the composer uses its focused border.

## Prototype boundaries and promotion criteria

`apps/desktop/prototype.html` mounts a separate React study. It uses the real shared
`ChatRun` and tokens; the shell, composer, diff, and provider work are simulations.
The shared component gained optional status-label and thinking-indicator props,
whose defaults preserve production rendering.

The approved main chat and composer treatment is now applied to the desktop UI
through `packages/ui/src/chat-design.css`. It retains the existing provider,
approval, attachment, queue, review, and Stop controls and event handling. The
sidebar and companion retain their existing appearance. This adoption changes
presentation only; the study's simulated state labels and results remain isolated.

Native checkout screenshots in `../screenshots/chat-design/` use an isolated
sample conversation, not a measured provider run. Type checking, focused chat,
queue and context checks, and the desktop bundle build passed. Native checks
covered composing text, expanding activity, opening model controls, and toggling
the companion. These checks do not establish streaming or recovery performance.

Before adopting further study behavior in the full desktop UI, validate it against real
streaming and long transcripts, connect state labels to authoritative events,
and resolve the measured cancellation/retry ambiguities. Do not copy the sample
18-second completion label, test result, or seeded diff into a real request.

Visual evidence and interaction measurements are in `2026-09-11/`. The measured
report distinguishes prototype checks from full desktop runtime verification.

## Goal and plan status ramp

The goal states the outcome; the plan describes the route. Completing every step
does not complete the goal. Changing chat mode preserves both the saved goal and
a goal draft. Plan mode carries the goal into the planning request.

| State       | Label             | Mark                                              | Token                   |
| ----------- | ----------------- | ------------------------------------------------- | ----------------------- |
| Not started | Not started       | Open circle                                       | `--gyro-faint`          |
| In progress | Working           | Dashed ring; rotation only without reduced motion | `--gyro-status-running` |
| Complete    | Completed         | Filled check                                      | `--gyro-status-success` |
| Blocked     | Blocked           | Minus in outlined circle                          | `--gyro-status-failed`  |
| Approval    | Awaiting approval | Diamond                                           | `--gyro-status-waiting` |

Dark status colors are tuned for graphite; light values resolve through the light
blue, success, warning, danger and muted tokens. Plan mode itself is neutral.
Use `ListChecks` for the plan and `Goal` for the outcome affordance.

`SessionGoalStrip` rides on the composer — mark, label, the outcome, its clock
and three controls on one line — so the goal stays on screen for every turn of
the chat instead of scrolling away at the top of the transcript, and saving one
is announced by the strip itself rather than by a sentence to read and dismiss.
Its mark rotates only while a turn for that chat is running: an open goal that
is idle is not work in progress. `SessionGoalBand` keeps the thread's compact
steps count with its Open plan action, and the rail's editable goal above either
Document or Steps. Blocking
is an explicit item action; the normal check cycle stays todo → working → complete.
Progress labels expose blocked counts to assistive technology as well as a dot.

Use `--gyro-radius-xl` on the goal strip where it floats above the start
surface, the plan artifact and the plan decision surface; inside a chat the
strip shares the composer's own radius and top edge.
At 620px, the strip truncates the outcome rather than its controls. Reduced motion removes status
rotation and progress transitions. Verification notes live in
[`docs/design/goal-and-plan/design-qa.md`](../design/goal-and-plan/design-qa.md).
