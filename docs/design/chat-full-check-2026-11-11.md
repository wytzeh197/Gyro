# Chat workspace — full design check

**Later implementation:** the three open sidebar/header findings below were
addressed in [the navigation follow-up](chat-navigation-review-2026-11-11.md).
The initial review and its verification boundaries remain recorded here.

2026-11-11. Review of the current local implementation after the list correction.
The installed app's empty workspace was inspected for comparison; it was not
replaced. The findings below distinguish regressions in the expanded local UI
from existing problems. This is a complete check of the chat design scope, not
acceptance of every Gyro feature or a live-provider test.

## Findings

| Priority | Finding | Result |
| --- | --- | --- |
| P2 | **File actions overlap the file count in narrow split panes.** At 900×700 with large interface size, the new agent-review action squeezed the title grid track to 0px. Undo, the file count and the multiline agent-review label overlapped. | **Fixed.** The existing header now wraps its title and actions. Actions align to the trailing edge; a button's label wraps only when the pane is narrower than the button. The new geometry check also caught and resolved the three-pane boundary. |
| P2 | **Run actions squeeze the work duration into multiple lines.** Save as workflow and Continue compete with the duration in a narrow pane. | **Fixed.** The status remains a single readable unit; secondary actions wrap below it when necessary. |
| P2 | **Mixed attachments stretch small cards to video height.** The 80px image preview became a 242px card and the PDF acquired a large empty area. | **Fixed.** Attachment rows align cards at their natural heights. The same image card now measures 82px including borders. |
| P2 | **Empty composers clip wrapped placeholders.** At the narrow three-pane boundary, the empty textarea stayed at 52px even though the placeholder needed 72px. | **Fixed.** The existing autosizing measures the placeholder as well as typed text. The empty field measured 72px with no hidden overflow; typing a wrapped multiline draft expanded to the existing 148px limit and correctly enabled scrolling. Clearing restored the empty state. |
| P2 | **Waiting badges consume the chat title.** In the 190px sidebar, Awaiting approval or Needs input leaves only a few visible title characters. | **Existing issue; open.** The current navigation owner reserves 102px/84px badges and fades the title underneath. Recommend a compact indicator with the existing full accessible description, or a second status line. This requires a sidebar design decision, separate from the chat correction. |
| P2 | **Pending approval uses the success color.** The green sidebar badge conflicts with the waiting state in the chat and the product's semantic waiting token. | **Existing issue; open.** `navigation-design.css:9` uses `--gyro-success`; the actual theme defines `--gyro-status-waiting` as `--gyro-attention`. Recommend using the waiting token consistently during the sidebar pass. |
| P2 | **Very narrow pane headers lose their identity.** Three panes at 900px with large interface text retain two ellipsis controls plus Environment, companion and Close while the first title is reduced to `B..` and the other titles disappear visually. | **Existing responsive-design issue; open.** Full titles remain in the accessibility tree. Recommend consolidating low-frequency header actions into the existing overflow menu at narrow pane widths, or imposing a comfortable minimum pane width. The current split mechanics and controls were preserved for this correction. |
| Verification | **The attachment fixture could not load.** Its two imports referenced the removed `site/assets` directory. | **Fixed.** The development-only fixture now uses existing repository documentation media. These are sample attachments, not a claim about current product imagery. |

## Visual evidence

- [Split before](screenshots/full-check-2026-11-11/split-light-large.png)
  and [split after, with keyboard focus](screenshots/full-check-2026-11-11/split-after-light-large.png).
- [Final split layout from the production matrix](screenshots/full-check-2026-11-11/split-final-production.png).
- [Three-pane boundary after correction](screenshots/full-check-2026-11-11/three-after-light-large.png).
- [Attachments before](screenshots/full-check-2026-11-11/attachments-light.png)
  and [attachments after](screenshots/full-check-2026-11-11/attachments-after-light.png).
- [Approval badge](screenshots/full-check-2026-11-11/approval-before.png)
  and [question state](screenshots/full-check-2026-11-11/question-light.png).
- [Plan mode](screenshots/full-check-2026-11-11/plan.png),
  [subagents](screenshots/full-check-2026-11-11/subagents-light-large.png),
  [Appearance](screenshots/full-check-2026-11-11/appearance-light.png),
  [Environment](screenshots/full-check-2026-11-11/environment-dark.png),
  [authentication recovery](screenshots/full-check-2026-11-11/recovery-light-large.png),
  and [cancelled retry](screenshots/full-check-2026-11-11/recovery-cancelled-dark.png).

All images are from this review's actual production components with fixture data.
The installed app comparison used different live local data and dimensions, so
it is contextual evidence, not a pixel-equivalence claim.

## Design-system checklist

| Check | Result and evidence boundary |
| --- | --- |
| Product tokens and components | **Pass for changes.** Existing scaled chat spacing and controls; no new colors, components or overlay styles. Chat CSS remains the production owner. |
| Empty/populated/live states | **Reviewed in the render matrix.** Empty state also visually compared with the installed app. |
| Body, code and list readability | **Pass in covered states.** Existing list/paragraph contracts retained; wrapped lists and numbering remain in the matrix. |
| Split, stacked and three-pane layouts | **Reviewed in matrix; corrected split manually reviewed.** New contracts inspect actual header content and button bounds for overlap/escape. |
| Approval and question action hierarchy | **Pass in inspected browser fixtures.** Primary Run command is distinct from Reject; question choices and free-text alternative remain visible. Sidebar findings remain open. |
| Error and recovery | **Pass in inspected fixtures.** Authentication failure exposes Sign in. Cancelling scheduled retry removes its scheduled status and Cancel control, leaving Retry. No provider action was performed. |
| Plan and delegated agents | **No clipping found in inspected fixtures.** Plan card and implementation dock, agent status and Environment panel inspected. This does not establish all subagent behavior. |
| Environment separation | **Pass in inspected state.** Reserved track does not overlap the reading column. |
| Attachments and file links | **Corrected and reviewed.** Mixed image/video/document cards, image preview, Escape dismissal and return of focus checked. File link uses the actual link color; full-file opening and native Finder actions were not exercised. |
| Keyboard access | **Pass for inspected controls.** Shift+Tab from agent review reaches Undo with the actual 2px blue focus outline. Image preview focuses Close and Escape returns focus to the originating thumbnail. Full keyboard and assistive-technology acceptance remains unverified. |
| Sidebar and settings consistency | **Existing issues recorded above.** Appearance layout inspected at 900px; no clipping found there. No sidebar/settings redesign was applied. |
| Native/live acceptance | **Unverified for corrections.** Installed empty workspace observed only. No install, provider turn, commit, push or release performed. |

## Verification

| Verification | Result |
| --- | --- |
| Final production render matrix | **Pass: 112 states, zero contract failures.** Both themes, three interface sizes, desktop/narrow widths, empty/finished/live/code/lists, split/stacked/three-pane and hover/focus cases. |
| New assertions | **Pass.** Header content and buttons remain inside their bounds without overlapping; empty composers do not clip their placeholders. Existing reading, list, radius, column, color and overflow assertions retained. |
| Source smoke and desktop TypeScript | **Pass.** Workbench, token, sidebar grouping and run-task source checks; `tsc --noEmit`. |
| Chat ownership and style budget | **Pass.** 2,804 rules, zero chat `!important`; no additional stylesheet owner. |
| Scoped patch whitespace checks | **Pass.** |
| Manual interactions | **Pass for inspected cases.** Undo keyboard focus, image-preview focus/Escape, retry cancellation, and narrow composer typing/clearing. |

The original 112-state comparison passed despite visible header defects,
demonstrating why its old box measurements were insufficient. The new geometry
assertions cover the missing outcome directly. The development verification
later rejected one stacked-pane capture that had reloaded into the startup
shell; it was not accepted as a new baseline. Its contract/log record is retained.
The complete final verification used the immutable production bundle to remove
development reloads from the measurement.

The 112-state baseline was deliberately updated after the corrections. Its
prior version, full production contracts/log, rejected development record and
source/typecheck logs are preserved under
`artifacts/chat-full-check-2026-11-11/`. Baseline differences cover the new wrapping
and composer heights, associated transcript positions, and minor rounded
empty-state positions. Exact pixel equivalence with the prior design is neither
expected nor claimed. Production screenshots are also saved by the renderer
under `artifacts/screenshots/chat-render/`; the selected manual review images
above preserve the visual findings.

## Recommended next design work

Resolve the sidebar's waiting-state treatment together: preserve a readable chat
title, keep the full status available to keyboard/assistive-technology users, and
use one semantic waiting color. Avoid treating a passing layout matrix as visual
approval; retain screenshot review for new controls and mixed content.
