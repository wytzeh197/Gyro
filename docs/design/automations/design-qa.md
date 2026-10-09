# Automation result-first layout — 9 October 2026

**final result: passed**

## Target and evidence

- Selected target: option 2, refined with the user's request to match current Gyro polish. Built-in Image Gen produced `refined-reference.png`; it was grounded in the selected image, the original screenshot, the current chat screenshot, and the existing appearance tokens.
- Source visual truth: `docs/design/automations/refined-reference.png`, 1655 × 950 pixels.
- Browser-rendered implementation: `docs/design/automations/desktop-dark.png`, 1470 × 844 pixels; CSS viewport 1470 × 844, screenshot density 1.
- The reference was normalized to 1470 × 844 for comparison, preserving its aspect ratio to rounding precision. Only QA copies were resized; the original reference is preserved.
- Combined full-view comparison: `docs/design/automations/comparison.png`. Source and implementation were inspected together in this image.
- Combined focused comparison: `docs/design/automations/detail-comparison.png`, showing the latest result, run history, and inspector side by side.
- State: selected weekly Update readme automation, active, completed latest run, mixed passed/failed history, collapsed advanced settings, dark comfortable/default appearance. Both reference and preview contain illustrative runs, not live provider results.
- Working preview: `http://127.0.0.1:1421/automations-preview.html`. It mounts the production `AppChrome` and `AutomationsSurface`; fixture callbacks and sample data are in memory.
- Additional evidence: `narrow-light-long.png` and `narrow-light-settings.png`, at 860 × 620, compact density, large interface text, long title, branch and result.

## Findings and comparison history

- Initial [P2]: a narrow detail pane let the header's action group squeeze a long title into single-letter lines. Evidence: `narrow-light-long-before.png`. The intermediate list stayed visible because the earlier breakpoint considered window width rather than the available content width.
- Fix: container-based list collapse below 900px of available scheduled-page width; title and action group stack below 700px of detail width. The inspector follows the history at narrow widths, with all fields still accessible by scrolling.
- Post-fix evidence: `narrow-light-long.png` shows the readable wrapped title, separate action row, complete result text and no document horizontal overflow. `narrow-light-settings.png` shows the model, full branch, instructions, advanced disclosure and execution note reachable below history.
- Final combined desktop comparison: no actionable P0/P1/P2 findings remain. The source's bright filled status medallions and fabricated timestamps are intentionally replaced with existing outline icons, restrained semantic colors, explicit status words and real prop-driven timestamps.
- Expected product constraints: original sidebar, unread result counts, complete provider error summaries, existing schedule-label wording, and a close-details button are retained. Suggestions are visually secondary near the bottom. Existing operational callbacks and running/paused gating are retained.

## Required fidelity surfaces

- Fonts/typography: shared system sans stack verified in computed styles. Heading 22px/28.6px, latest result 16px/24.8px, instructions 14px/22.4px; support text 13px and micro text 12px. Shared interface-size variables remain effective. Long content wraps instead of clipping.
- Spacing/layout: flat result and inspector columns, 28px outer/gutter spacing, 24px section rhythm, row separators and token-controlled compact controls. At desktop the intermediate list is 300px. Narrow content collapses the list and stacks the inspector. No cards inside cards or new floating surfaces.
- Colors/tokens: computed detail background is rgb(24,24,24), text rgb(237,237,237). Borders, secondary text, primary action, green success and pink failure use shared theme tokens. Light mode and large text were inspected.
- Image/assets: no new raster assets are consumed by the UI. Existing Gyro/provider marks and the existing Lucide icon library remain in use. The Image Gen mock is a design reference only. Outline status icons avoid large decorative medallions.
- Copy/content: actual automation title, project, schedule, timezone, model, branch, instructions, workspace, execution owner, stop condition and full run summaries are preserved. Technical execution details live under Advanced settings. Status has both an icon and a visible word. Open chat is exposed only when a session and callback exist.

## Verification and limits

- UI and desktop TypeScript checks passed.
- Desktop production Vite build passed after the final responsive CSS change; the existing bundle-size warning remains.
- Workbench smoke checks and UI token checks passed. Diff whitespace check passed.
- Browser interaction checks: Pause disables Run now and replaces Pause with Resume; Resume restores the scheduled state; Archive clears the fixture unread count and disables itself; Run now transitions through Running with Run/Edit disabled, then completion; Advanced settings expands; Edit saves an updated title; Open chat opens the selected run's fixture destination.
- The edit fixture initially omitted the create callback required by the existing form contract. The fixture was repaired; saving was then verified. Production form behavior was not changed.
- Browser console error/warning logs were empty in the final preview.
- Native scheduler/provider execution was not exercised. The installed macOS app was not rebuilt or replaced; the production frontend source is updated.
- No new behavior tests were added for this presentation change. The separate development fixture supports manual inspection without live commands or model calls.

## Implementation checklist

- Result-first layout applied to the production automation detail.
- Existing Edit/Pause/Resume/Reactivate/Run/Archive/Open chat behavior retained.
- Readable history rows, semantic labels and full instructions verified.
- Responsive issue fixed and recaptured.
- Visual comparison completed; working preview left open.

## Follow-up polish

- No blocking polish remains. Run-history timestamps continue using Gyro's existing relative format; their title exposes a scheduled-timezone absolute time.
