# Split-screen chat chrome — 2026-09-06

final result: blocked

## Source and state

- Source visual truth: `/Users/wytzehemrica/Library/Application Support/Gyro/sessions/attachments/0348e4c2-41ea-4e63-a081-abe80f48a249/425bc24ad221f6cc39bfc437f2ae22879c5e59d0bc46537b9e1ab0e8ed4bae0d.png` (2048 × 1246).
- Compared state: light theme, sidebar hidden, three tiled chats with the right column split horizontally.
- Implementation screenshot: unavailable because app capture access was not approved. A same-state pixel comparison and focused crop are therefore blocked.

## Changes made

- The sidebar restore toggle uses a split-screen-specific vertical offset so it keeps the same baseline as the single-pane header.
- Hidden-sidebar title clearance is limited to the first tiled pane; other pane titles align to their conversation columns.
- Tiled header height is normalized to the existing 38px grid row, with symmetric content-width-aware padding.
- Grid slots no longer add transparent borders over the grid gap, leaving one clean divider seam at pane intersections.

## Findings and verification

- Source P2: restore toggle was vertically low in the split layout. Fixed in CSS; rendered confirmation pending.
- Source P2: titles in non-leading panes inherited left-side toggle clearance. Fixed by scoping the clearance to the first pane.
- Source P2: tiled headers used a 42px minimum inside a 38px grid row. Fixed by matching both dimensions at 38px.
- Source P2: slot borders layered over the grid divider. Fixed by making the grid gap the sole pane seam.
- Typography, copy, colors, icons, and imagery are unchanged by this pass.
- Prettier, TypeScript checks, the desktop production build, the focused split-screen UI contract, and diff whitespace checks pass. Vite retains its existing bundle-size advisory.
- The broader workbench smoke check has four unrelated provider/state contract failures. None references the split-screen CSS or its focused assertion.

## Remaining verification

Capture the same three-pane state after rebuilding, then compare the restore-toggle baseline, title/content alignment, header action spacing, and divider intersections against the source image. Until that rendered comparison is available, visual QA remains blocked rather than passed.

---

# Workspace context menu — 2026-09-06

final result: blocked

## Source and state

- Source visual truth: `/Users/wytzehemrica/Library/Application Support/Gyro/sessions/attachments/e0948833-8662-4caf-8f3f-4d7aa73dbaed/2d524336913cc18a4aefb8c2bc728ded87995cb7a5806c2a37f935642f1de8c0.png`.
- Source crop: 814 × 158 pixels; density and original CSS viewport are not encoded in the attachment.
- State: light theme, active chat, workspace context menu opening downward from the thread header.
- Implementation screenshot: unavailable because the project browser preview could not be opened in this turn.

## Findings and implementation

- P1 clipping: the animated conversation canvas formed a later stacking context and painted over the header-owned menu. The thread topbar now has an explicit elevated stacking layer and visible overflow; the canvas has an explicit base layer.
- P2 panel hierarchy: the menu used oversized rows, loose spacing, and card-like framing. It now uses a 312px compact grouped layout, a separated title, smaller section labels, 36px rows, restrained active states, and an opaque theme surface.
- Responsive placement: the existing popover bounds logic is now enabled for the header menu so it constrains height and horizontal placement to the available surface.

## Verification

- Full-view and focused visual comparison: blocked because no browser-rendered implementation capture was available. The supplied source was opened and inspected at original resolution.
- Typography: existing Gyro font retained; menu title 12px, section labels 10px, row labels 12px, detail copy 11px.
- Spacing/layout: implementation rules define a 312px bounded menu, 6px outer padding, 36px minimum rows, and 10px radius.
- Colors/tokens: existing surface, border, text, muted, and accent tokens retained for light/dark compatibility.
- Assets/icons: existing Lucide UI icons retained; the reference contains no raster assets requiring replacement.
- Copy/content: existing project, workspace mode, and branch labels and actions are unchanged.
- Primary interaction and console checks: blocked with the browser-rendered comparison.
- Automated checks: desktop TypeScript and production build passed; Prettier and diff whitespace passed. The targeted workspace-menu smoke assertion passed. The broader workbench smoke suite still reports four unrelated provider/session failures already present in the working tree.

## Comparison history

- Initial evidence: the source showed the menu visible for roughly one title row before the following canvas covered it.
- Fix applied: established topbar/canvas z-order, enabled bounded popover placement, and tightened the dedicated menu styling.
- Post-fix visual evidence: unavailable; final visual comparison remains blocked.

---

# Inline approval cards — 2026-09-06

final result: blocked

## Implementation

Option 1 is implemented in `packages/ui/src/inline-approval-card.tsx` and wired into both existing transcript approval renderers. The composer is unchanged by this approval-card work. Command, file-change, permission, and capability cards retain their existing decision callbacks and policy scope. File diffs can be expanded before approving. Pending, approved, applied, rejected, cancelled, failed, and expired presentations use explicit status text.

## Source and evidence

- Selected visual: `docs/design/inline-approval/approved-reference.png` (first displayed approval option).
- Real-app development fixture: `/capture.html?scene=chat&theme=light&edge=inline-approval`; add `&approval=file` for file changes. Its resolver is in-memory and never executes a command.
- Browser: Codex in-app browser. Page and accessibility reads succeeded, but mouse dispatch, keyboard dispatch, and subsequent reload attempts repeatedly timed out. Fresh tabs did not restore input. Chrome fallback was unavailable.
- The browser remained on the welcome composer; no rendered approval-card screenshot or valid visual comparison was obtained. Visual QA and interactive acceptance are therefore blocked, not passed.

## Checks

- Desktop TypeScript check and Vite production build passed. Vite reports the existing bundle-size advisory.
- Workbench/token smoke checks and diff whitespace checks passed. The existing approval smoke assertion was updated to inspect the extracted shared card, including accessible labels, status, errors, and keyboard focus styles.
- Source review confirms that each decision still receives its original approval/proposal ID, commands offer approve/reject only, and project-wide grants remain limited to capability requests.
- No broad approval policy changes, permission grants, live commands, or composer changes were introduced.

## Remaining verification

Inspect command and file cards against the approved reference in light/dark and narrow chat panes; verify approve/reject resolution, file-diff disclosure, and existing backend failure behavior. Typography, spacing, colors, icons, and dynamic content still need rendered comparison. Do not treat earlier reports below as approval of this new card design.

---

# Gyro effort selector — 2026-09-06

final result: passed

Implemented in the existing composer, using the approved pill-slider mockup.

## Visual evidence

- Source visual truth: `docs/design/effort-selector/approved-reference.png` (1568 × 1003).
- Light implementation: `docs/design/effort-selector/implementation-light.png` (842 × 759).
- Dark implementation: `docs/design/effort-selector/implementation-dark.png` (842 × 759).
- Compact implementation: `docs/design/effort-selector/implementation-compact.png` (600 × 480).
- Focused comparison: `docs/design/effort-selector/comparison.png`, approved source left, implementation right.
- Viewport: 842 × 759 CSS pixels, reported devicePixelRatio 2. Browser export is normalized to 842 × 759 pixels. Compact viewport is 600 × 480 CSS pixels; temporary viewport override was reset.
- Compared state: effort popover open, GPT-6 Astra, Medium selected. Cropped source and implementation panels normalized to 612 pixels wide for comparison. Full application captures were also inspected for placement, composer integration, and clipping.

## Findings and comparison history

- Initial check: the remaining slider track was nearly white because its surface token was undefined. Corrected it to the existing `--gyro-surface` token.
- Initial check: translucent popover allowed nearby text to show through. Applied an opaque theme surface with sufficient specificity.
- Final check: no actionable P0/P1/P2 findings. The 306 × 123 CSS-pixel popover has a 276 × 29 pill track and a 33-pixel white native thumb. It opens above the composer when space permits and preserves the existing placement fallback.
- Typography: existing Gyro font, 16px effort heading and 14px secondary model label preserve hierarchy. Text truncates for long model names.
- Spacing/layout: centered two-line heading, corner icons, wide rounded track, and compact pill trigger match the selected structure. P3: the implemented popover is slightly taller relative to its width than the generated reference, retaining readable Gyro font sizes.
- Colors: blue selected effort and fill, neutral remaining track, opaque light/dark surfaces, and white thumb verified.
- Assets: existing provider logos and Lucide navigation/reset/lightning icons; no raster UI approximation.
- Content: current model and supported effort levels come from the existing provider catalog. Astra has six supported stops in the app, rather than the five illustrative stops in the mockup. No models or capabilities were invented to match reference text.

## Interaction and technical verification

- Dragged Astra from Medium to Ultra; selected effort updated in composer while the popover stayed open.
- Keyboard End selected Max for Claude; reset restored its High default. Astra reset restored Medium.
- Opened model list, switched provider and model, and verified the new model/default effort.
- Verified provider settings remain reachable through the lightning button.
- Verified Escape returns from model list to slider, then dismisses and restores trigger focus.
- Verified outside-click dismissal and reopening, and the existing fallback menu for a model without effort choices.
- Inspected light, dark, and compact layouts; no clipped slider or control overlap.
- Browser console: no errors reported during verification.
- Desktop TypeScript check, Vite production build, workbench/token smoke checks, Prettier, and diff whitespace checks passed. Vite retains its bundle-size advisory.
- Validation uses the real React app with the repository's in-memory capture harness; no live provider request was sent. Native macOS app packaging/installation was not performed.

---

# Gyro design quality upgrade — current review

**Date:** 2026-09-05
**Status:** Implemented and technically verified; awaiting visual acceptance.
**Runtime:** Current checkout native debug bundle, not the installed release.

Review the [96 matching before/after pairs](artifacts/screenshots/design-upgrade/review.html), [verification notes](artifacts/screenshots/design-upgrade/verification.md), and native screenshots under `artifacts/screenshots/design-upgrade/native/`. The four stages cover shared controls and typography; settings and menus; navigation and conversation; workspace and companion tools. Existing checkout changes and saved preference formats are preserved.

The earlier QA records below are historical and do not substitute for this upgrade's visual acceptance.

---

# Codex-style Companion Layout — Design QA

**Result:** Passed for the frontend layout and checked interactions.
**Date:** 2026-09-04
**Implementation:** current `/Users/wytze/Gyro` checkout; not an installed-app update or release.

## Reference and comparison

The two supplied Codex screenshots (13.58.13 and 13.58.18) were opened alongside the rendered picker and blank-browser captures in the same comparison input. The preview used a 1580×958 content viewport matching the reference app's interior. Gyro retains its existing 240px product sidebar and its own task content; the companion layout leaves a 424px conversation column and gives the remaining space to the tool.

Captures: `artifacts/screenshots/codex-panel-layout/picker.png`, `browser.png`, and `browser-dark.png`.

## Checked behavior

- Opening Panel without a tool shows the centered five-tool picker.
- Review, Files, and Browser open as real existing tool surfaces; tab switching, closing, and reopening preserve the strip.
- The browser uses a separate tab strip and address row, with a genuine blank New tab state.
- Expand/restore, hide/reopen, the bottom drawer, and keyboard divider resizing work. ArrowRight reduced the observed width from 914px to 890px; ArrowLeft restored it.
- A submitted localhost address updates the selected tab and navigation controls. Browser options open and dismiss. Blank-page capture and external-open controls are disabled.
- Light and dark themes render. At 1024×700 the existing compact overlay keeps the browser navigation and close controls accessible.
- Browser console warnings/errors in the final checked state: none.

## Findings resolved

Removed the old 20px chat/panel gutter, full-width chat header, inset tool-card framing, and redundant Environment label. Corrected address-field sizing, Review's leftover empty grid row, narrow-toolbar clipping, missing Files rows when ancestors were not expandable, and invalid-address handling. URL normalization covers explicit URLs, local ports, and search terms while rejecting unsupported schemes.

No P0/P1/P2 layout issues remain in the checked states. Known scope differences: one tab per tool remains Gyro's existing model (not multiple independent web pages); product navigation, task content, and provider controls remain Gyro-specific. Native WKWebView lifecycle was not exercised end-to-end: the capture harness supplies the native bridge, and installed app instances were left unchanged.

## Automated checks

UI and desktop typechecks, frontend production build, reliability suite, browser-address boundary checks, companion regression checks, and `git diff --check` passed. The full workbench smoke command still reports the three previously existing dirty-checkout contract failures (first-send provider execution, clean-thread defaults, and composer action routing). Its companion assertion was updated to recognize the new empty picker; that assertion passes. No baseline failures were suppressed.

---

# Gyro Core Design Upgrade — Design QA (previous pass)

**Result:** Passed
**Date:** 2026-09-03
**Implementation:** current `/Users/wytze/Gyro` checkout

## Scope

This pass covers the shared visual foundation plus Sessions/chat, Workspace/source control, and Settings. It preserves the existing Sessions/Workspace split, provider and project controls, approval modes, attachments, Git actions, theme and density preference types, and current persistence callbacks. No backend command, persistence migration, or public type was added for this work.

## Reference comparison

Reference and implementation were reviewed together at matching states and a 1600×975 viewport. The implementation keeps Gyro's 240px navigation rail and developer-oriented information architecture while adopting the references' neutral surfaces, flatter hierarchy, clearer type rhythm, and restrained use of elevation.

| State       | Combined comparison                                                                                                 | Result                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Welcome     | `/Users/wytze/.codex/visualizations/2026/09/03/01a0675f-4925-7092-ba8d-fb4c2c36031e/gyro-design-qa-welcome.png`     | Passed — centered action cluster and bottom composer read as two clear levels.               |
| Active chat | `/Users/wytze/.codex/visualizations/2026/09/03/01a0675f-4925-7092-ba8d-fb4c2c36031e/gyro-design-qa-active-chat.png` | Passed — calm 760px reading column and quieter message controls.                             |
| Appearance  | `/Users/wytze/.codex/visualizations/2026/09/03/01a0675f-4925-7092-ba8d-fb4c2c36031e/gyro-design-qa-appearance.png`  | Passed — flat groups, one selected-theme treatment, and a separate density row.              |
| Workspace   | `/Users/wytze/.codex/visualizations/2026/09/03/01a0675f-4925-7092-ba8d-fb4c2c36031e/gyro-design-qa-workspace.png`   | Passed — clearer source-control order, lighter framing, and a contextual editor empty state. |

## Capture matrix

Deterministic fixtures cover `welcome`, `active-chat`, `workspace-source-control`, `selected-diff`, and `appearance` in light and dark themes at:

- 1600×975 (`reference`)
- 1440×900 (`desktop`)
- 1024×700 (`compact`)

The complete QA-only capture set is in `/Users/wytze/Gyro/artifacts/screenshots/gyro-quality-after/`. It is separate from marketing assets.

## Runtime verification

- Current debug executable confirmed at `/Users/wytze/Gyro/target/debug/gyro-desktop`.
- The current checkout's development window loaded the Gyro workspace and `release/v0.1.0-alpha.45` branch.
- Light, Dark, and System theme controls render and switch correctly.
- Compact and Comfortable density controls render and switch correctly.
- Theme selection persists after navigating away and reloading the preview.
- Keyboard traversal exposes the distinct 2px focus-visible treatment.
- The composer approval menu, New Session menu, environment review rail, and source-control disclosure controls open correctly.
- Source-control bulk actions remain hidden with no selected files and appear after file selection.
- GitHub details start collapsed.
- The selected-diff fixture shows real deterministic diff content.
- Sidebar resizing remains available.
- Reduced-motion rules disable the transitions introduced by this upgrade.
- Browser console errors during the checked flows: none.

## Visual findings

- P0: none.
- P1: none.
- P2: none after flattening the theme/density group and replacing the generic editor prompt.
- P3: none required for acceptance. Gyro intentionally retains its denser IDE structure and 240px shared rail rather than copying the reference shell.

## Automated checks

- `CI=1 pnpm format`: passed.
- `CI=1 pnpm typecheck`: passed.
- `CI=1 pnpm lint`: passed.
- `CI=1 pnpm smoke:workbench`: the new visual-token assertions pass, but the command still reports three existing dirty-checkout product-contract failures about first-send provider execution, clean-thread defaults, and composer action routing. They are outside this visual-only change and were not added to or hidden by the acceptance criteria.
