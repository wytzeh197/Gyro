# Sidebar waiting states and narrow chat headers

2026-11-11. Follow-up to the three remaining findings in the
[full chat check](chat-full-check-2026-11-11.md), authorised by “Continue with the rest.”

## Result

All three design findings are addressed locally in the actual production components.

- **Sidebar title space:** approval and question status now use compact existing
  PauseCircle/MessageSquare glyphs. The title no longer fades underneath a wide
  status pill. Full status and count remain in the row's accessible label and
  native tooltip; pointer hover and keyboard focus retain Pin/More access.
- **Waiting color:** both pending-decision states use the existing semantic
  `--gyro-status-waiting` token, including the glyph itself. Approval no longer
  borrows the success color. Provider identity, running and unread states retain
  their existing behavior.
- **Pane identity:** the thread has one overflow menu, in the action group. At the
  existing 360px pane breakpoint, Environment/companion/drawer actions move into
  that menu, while Close remains direct. Wide panes retain direct surface
  controls. Plan and Save as workflow remain available through the same menu.

The earlier left-hand duplicate menu was removed. Narrow menus now anchor to
the whole action group, keeping their bounds inside the pane rather than
clipping their left edge. Unavailable drawer handlers are excluded rather than
exposing an inert menu item. Chat splitting, close handlers, provider actions and
saved user data were not redesigned.

At 900×700, large interface size, the three title boxes measured approximately
130px / 106px / 106px, with one overflow menu in each pane. The earlier review
showed one abbreviated initial and two visually absent titles. The approval
indicator measured 27.6px at large size; the sidebar title retained 91px.

## Evidence

- [Narrow pane menu](screenshots/navigation-2026-11-11/three-menu-light-large.png)
- [Narrow headers, keyboard focus](screenshots/navigation-2026-11-11/three-header-light-large.png)
- [Final waiting indicator](screenshots/navigation-2026-11-11/approval-final.png)

The earlier before images remain in the full review. These are actual components
with local fixture data. The installed app was not replaced.

## Verification

| Check | Result |
| --- | --- |
| Focused production matrix | **Pass: 36 states.** Approval, question and three-pane scenes × two widths × two themes × three text sizes. The new `--navigation` option leaves the original matrix available. |
| Render contracts | **Pass.** Readable title allocation; compact waiting indicators; correct parent/glyph waiting color; retained full tooltips/accessibility labels; one pane overflow menu; direct secondary controls removed at narrow widths. Existing body/composer/list/overflow contracts also ran. |
| Keyboard/menu interaction | **Pass in inspected preview.** Enter opens More; ArrowDown reaches Save as workflow; Escape closes and returns focus to More with the actual 2px accent outline. |
| Relocated actions | **Pass in inspected preview.** Environment opens its actual panel; Show companion opens the actual companion and Hide companion returns to the chat. No provider turn was sent. |
| Menu bounds | **Pass in inspected narrow pane.** Menu x=210–416 within pane x=190–424. |
| Source smoke and TypeScript | **Pass.** The old source guard was corrected to expect a drawer handler only when the drawer is available. Workbench/token/sidebar grouping/run-task checks and desktop `tsc --noEmit` passed. |
| Semantic token ratchet | **Pass.** Removing the old fade mask removed one raw hex literal; budget decreased from 272 to 271. |
| Chat CSS rule ratchet | **Pass at final check**, within the unchanged 2,804 ceiling and with zero chat `!important`. This pass adds two narrow rules and removes two obsolete left-menu rules, net zero. A temporary excess during concurrent composer work was resolved in the shared checkout; those edits and the ceiling were preserved. |
| Native/live acceptance | **Unverified.** Browser fixtures and production bundle only; no installation, provider turn, commit, push or release. |

The production build and this pass's logs are retained under
`artifacts/chat-navigation-2026-11-11/`. Another concurrent renderer replaced the
shared `render-contract.json` after this run, so the dedicated 36-state success
log is the retained numerical result. The original 112-state baseline was not
rewritten to accept concurrent composer changes; its integration must be
reconciled with that work. This pass does not claim a newly accepted full-product
baseline or complete accessibility compliance.

## Review-screen outcome

Existing tokens, glyphs, controls and the menu's keyboard/dismissal behavior were
reused. Approval and question states now agree on the meaning of waiting. Status
is available independently of color. The primary chat/approval actions retain
their hierarchy, and narrow headers preserve identity without removing access
to their tools. No shared instructions were modified.
