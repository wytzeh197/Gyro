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
