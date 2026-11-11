# Chat consolidation — implementation review

**Latest full check:** [2026-11-11 chat workspace review](chat-full-check-2026-11-11.md)
records the later narrow-pane, attachment and composer corrections, plus open
sidebar and responsive-header findings.

**Later visual correction:** the initial list gutter was rejected and corrected
in [the follow-up design pass](chat-design-pass-2026-11-10.md). That review is the
current visual record; the 100-state results below describe the earlier
consolidation stage. The current baseline has 112 states.

2026-11-10. Chat steps 1–5 are implemented locally. The work is uncommitted;
the installed Gyro app was not replaced. Sidebar and settings remain the
separate follow-on screens in step 6.

## Result

The development preview and normal app now use the same production chat
stylesheet. `packages/ui/src/chat.css` owns the transcript, composer, start,
header, pane, question, recovery, plan, subagent and canvas styles. Components
retain their existing markup and behavior; their former CSS imports were
removed. Eleven empty component/overlay stylesheets plus the former chat-design overlay were deleted. Shared shell
material, provider logos, file identities, navigation and other screens retain
their own owners.

The approved design has a 760px column with scaled 24px pane gutters; 15px / 1.6
reading metrics shared by live narration and final replies; 13px supporting
text and 12px metadata; 12px chat surfaces and an 18px composer. Core blocks
have one sizing/type/surface rule. Turn and block margins use the 24px/12px
tokens rather than the historical 34px/28px values. Utility controls keep the
product's existing geometry.

Environment uses its actual component and handlers in a reserved right grid
track. Tight composer toolbars wrap while retaining their actions. Ink actions
include a distinct ink hover treatment; focus resolves to the chosen accent.
Media captions retain fixed contrast on photographed content. Existing semantic
status and diff tokens remain meaningful.

## Consolidation evidence

- The PostCSS move preserved selector order and conditional wrappers, split
  mixed selector lists, and moved whole less-frequently exercised component
  files. There is no isolated CSS layer or production preview-ID override.
- All 100 pre-change computed snapshots matched after the move and safe
  duplicate cleanup. All 36 separately bundled production snapshots matched
  their original development values too.
- Pure-move screenshots matched exactly in 91 of 100 images. Nine images had
  3–26 changed header antialiasing pixels, at most 3/255 per channel. No measured
  property changed. Exact pixel identity is therefore not claimed.
- The initial expanded extraction contained 2,821 rules and 8,751 declarations;
  another 57 auxiliary alias rules were brought under ownership. The final
  stylesheet has 2,808 rules and zero `!important` declarations. The original
  extraction had 14. The draft's “under a quarter” rule-count estimate was not
  supported; unobserved states were preserved instead of deleted to hit it.
- The extraction and collapse reports, original sources and baselines remain
  in `artifacts/chat-consolidation/`. `scripts/chat-render-baseline.json` is the
  deliberately recorded final 100-state baseline.
- An unrelated pre-existing provider-allowance typo, `--gyro-warning`, was
  exposed by reading all stylesheets and corrected to the actual `--gyro-warn`
  token.

## Verification

| Check | Result and boundary |
| --- | --- |
| Final rendered design | Pass, 100 states: start/thread/live/code/split/stacked/three-pane × two viewports × two themes × three interface sizes, plus 16 hover/focus cases |
| Rendered contracts | Pass: shared edges and gutters, reading metrics, metadata floor, core radii, no composer/page overflow, Environment separation, accent focus, readable ink actions and hover |
| Final production bundle | Pass, 36 states compared with the final baseline and design contracts; recorded linked bundled CSS assets, not dev CSS |
| Desktop TypeScript | Pass, `pnpm --filter @gyro-dev/desktop exec tsc --noEmit` |
| Source smoke and token guards | Pass, including nested UI stylesheets, one chat owner, semantic tokens, zero chat `!important`, token authorities and decreasing budgets |
| Smoke integration | Pass on a fresh local port with one filtered narrow/light/large state; separately preserved full 100-state contract evidence |
| Drag browser suite | Pass: protected/native payloads, pointer gestures, reorders, row/stack/grid targets, resizing, capacity, cancellation, draft retention, maximize, foreign projects and narrow layouts |
| Chat hardening / drag source checks | Pass |
| Companion motion | Pass, including cancellation, reduced motion, resizing, delayed layout and unmount |
| Actual preview interaction | Model picker with an unsent draft, approval request, question composer, Environment and native split gesture visually reviewed |
| Native WebKit | Isolated actual app build with disposable native session data; code/lists, disconnected-provider composer, Environment and two panes visually checked; sidebar drag retained separate Beta/Gamma drafts |
| Remote CI | Configured to run source smoke plus 100 machine-independent contracts and retain failure evidence; remote CI was not run here |

The drag browser suite had three obsolete fixture assumptions: starting a drag
on an intentionally inert pane title, resizing a flex child by `width` rather
than resizing its owning workspace, and looking for a removed “Processes” row.
The fixture now invokes the real pane callback for native payload-contract
cases, resizes the workspace, and crosses the actual nested Changes row.
Production interaction code was not changed to satisfy the fixture.

Startup fixture capture now waits for populated session panes and retries a
disposable fixture once if session restoration races list hydration. A repeated
wrong scene fails rather than being accepted as a new golden. Native seeded
transcripts were used for layout review, not turn-chronology or provider
acceptance. No provider turn, commit, push or release installation was performed.

Native visual review preceded the final margin-only cleanup. The disposable
native review bundle was rebuilt successfully from final source, but the browser matrix is
the numerical proof for final spacing. See `mockups/chat-thread/README.md` for
preview controls and commands.

## Review checklist

| Agent Design System check | Outcome |
| --- | --- |
| Actual product tokens/components | Pass; Geist, actual palette, real React app and controls |
| Empty/populated/loading/live states | Pass in fixtures; startup preparations settle before capture |
| Error/recovery/plan/subagent states | State selectors preserved and tokenised; exhaustive interaction acceptance not claimed |
| Truthful status | Existing state derives from real components; preview backend responses explicitly remain fixtures |
| Action hierarchy | Neutral ink actions and clear disabled/Stop states; existing semantic status colors preserved |
| Keyboard focus | Composer focus checked in both themes; actual model picker and question focus reviewed |
| Native/live boundary | Native layout and pointer split checked; live provider, installed release and all native themes remain unverified |

## Artifacts

- `mockups/chat-thread/screenshots/applied/production-thread.jpg`: actual
  production-styled React preview, fixture repository/provider data.
- `mockups/chat-thread/screenshots/applied/native-split.png`: actual native
  two-pane review before final margin cleanup.
- `artifacts/chat-consolidation/render-contract-applied-100.json`: preserved
  full final-spacing contract run.
- `artifacts/chat-consolidation/pure-move-pixel-review.json`: exact pixel-diff
  scope and maximum channel variation for the pure move.
- `artifacts/chat-consolidation/inventory/production-final.json`: actual bundled
  stylesheet inventory.

## Follow-on scope

Step 6 calls for separate sidebar and settings baselines, decisions and reviews.
Those screens have not been redesigned or consolidated as part of the chat
change. Existing unrelated work in this checkout was preserved.
