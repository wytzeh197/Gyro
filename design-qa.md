# Gyro Core Design Upgrade — Design QA

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
