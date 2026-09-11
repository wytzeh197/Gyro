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
whose defaults preserve production rendering. No production styling is overridden.

Before adopting the study in the full desktop UI, validate it against real
streaming and long transcripts, connect state labels to authoritative events,
and resolve the measured cancellation/retry ambiguities. Do not copy the sample
18-second completion label, test result, or seeded diff into a real request.

Visual evidence and interaction measurements are in `2026-09-11/`. The measured
report distinguishes prototype checks from full desktop runtime verification.
