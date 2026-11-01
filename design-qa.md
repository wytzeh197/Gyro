# Provider copy and setup-card follow-up

- Requested connected-state result verified in `docs/provider-settings/minimal-copy.jpg`: short page description, CLI accounts heading with count, no subscription paragraph, Accounts & models heading without setup instructions, and zero connection-method cards in the rendered DOM.
- Unknown allowance uses a dash; accessible label and tooltip retain the full unavailable explanation. Loading and reset states use short labels.
- Connection-method cards and sign-in guidance are conditional on no connected providers. Account-management actions remain available below the status strip.
- UI and desktop TypeScript checks, workbench smoke checks and diff whitespace checks passed.
- A development-only disconnected fixture was added for the first-connection check. A concurrent missing automation stylesheet temporarily blocked reload; once that file arrived, browser verification resumed. `docs/provider-settings/setup-disconnected.jpg` confirms 0 connected and all three setup cards visible.
- Connected-state and disconnected-state visual result: passed.

---

# Provider tooltip follow-up

**final result: passed**

- User reference: screenshot supplied on October 9 showing a wide tooltip clipped behind the sidebar in the wrapped provider row.
- Fix: 200px tooltip with compact padding, centered over its provider and clamped to the provider section with a 12px inset. Both pointer entry and keyboard focus calculate the position; keyboard focus uses the fixed width when the tooltip has not yet painted.
- Evidence: `docs/provider-settings/tooltip-fixed.jpg`, captured in the narrow settings view. Measured tooltip width 200px; left edge 236.20px; sidebar ends at 190px; provider section starts at 224.20px. First and last provider tooltip bounds are inside the section.
- Existing typography, theme tokens, content, logos and rings retained. Long content wraps inside the narrower tooltip.
- UI TypeScript check and diff whitespace check passed. Browser rendering, pointer entry and keyboard focus verified.

---

# Connected CLI allowances in Settings → Providers

**final result: passed**

## Target and evidence

- Source: `docs/provider-settings/reference.png`, copied from the selected Image Gen concept.
- Implementation: `docs/provider-settings/dark.jpg` and `preview.jpg`; live preview `http://127.0.0.1:1420/capture.html?scene=providers&theme=dark`.
- Full-view comparison: `docs/provider-settings/comparison.jpg`. Both source and implementation were opened together in this combined image.
- Focused comparison: `docs/provider-settings/strip-comparison.jpg`, source above implementation. The source's 1138 × 167 status strip is normalized to the production 860 × 128 strip.
- Source and desktop implementation: 1536 × 1024 pixels, CSS viewport 1536 × 1024, density 1. Additional captures: light theme 1280 × 720 and narrow window 860 × 620.
- State: Settings Providers subpage, three connected CLI accounts; Codex 68% remaining, Claude 24%, Gemini unreported. All preview readings are fixture data; production receives the existing live usage map.
- Tooltip evidence: `docs/provider-settings/tooltip.jpg`. Keyboard focus exposes provider name, allowance window and reset time.

## Findings and comparison history

- No actionable P0/P1/P2 issues remain within the requested scope: the compact logo-and-ring status component at the top of the existing Providers settings subpage and removal of the legacy provider screen.
- Expected product constraints: retain Gyro's existing settings navigation, connection-method links, model selectors, full provider catalog, account repair, API-key and local-model controls below the strip. This request does not replace those working controls with the concept's shortened mock table.
- Expected data constraint: the concept's Gemini 91% was illustrative. Gemini's current integration supplies no account allowance; its neutral track and explicit unavailable label preserve that fact.
- Existing compact settings typography and theme tokens are intentionally retained; the ring component is 64 × 64 pixels and the desktop strip is 128 pixels tall. The narrow window wraps the copy and indicators into two rows without horizontal overflow.
- Implementation fixes before comparison: keyboard focus outline added; labels and ring dimensions honor the interface-size scale; outdated provider navigation descriptions were updated after exercising the old search action.
- Final full-view and focused comparison confirms the compact top strip, recognizable provider marks, clockwise remaining-allowance arcs with rounded caps, count badge, readable percentages, and connection controls below it.

## Required fidelity surfaces

- Typography: existing product Inter family, 14px semibold section heading, 12px secondary copy, 11px labels and badge, tabular percentages. Text and ring dimensions honor the existing interface-size scale.
- Spacing: 20px/24px strip padding, 20px section gap, 16px indicator gap, 64px rings. Flex wrapping preserves all logos and complete labels at 860px viewport width; no document horizontal overflow.
- Colors: theme surface, border, foreground and muted tokens. Green indicates available allowance, amber low allowance, red critical, neutral unreported. Light and dark captures checked.
- Asset quality: reuse the product's existing provider logo components; no generated raster approximations. Circular SVG geometry draws a data meter rather than a replacement logo. Marks remain sharp at 30px.
- Content: connected CLI accounts only, remaining percentage rather than spent percentage, most restrictive live window governs each ring. Tooltip lists all nonexpired reported windows. Unmeasured, exhausted, expired, cached and loading states preserve what the provider reported.

## Verification

- UI and desktop TypeScript checks passed; production Vite build passed.
- Workbench smoke checks, clean-machine activation checks and surface-boundary checks passed.
- `scripts/check-provider-allowance.mjs` passed: restrictive weekly allowance, unmeasured/reset-only windows, exhaustion without a percentage, expiry, malformed numeric readings, clamping, sub-1% allowance, cached/error readings and legacy route redirection.
- Browser: settings navigation; keyboard tooltip and focus; provider details open/close; Use in chat returns to the selected model; old Open providers search action opens Settings → Providers.
- Light-preview browser console checked: no errors. Earlier development-tab hot reload errors occurred while newly imported files were being created; the completed preview renders correctly after navigation.
- No authenticated native account was contacted for browser QA; the existing native usage polling integration is reused unchanged.

## Implementation checklist

- Compact status-only strip implemented at the top of the correct subpage.
- Legacy Agents & Providers component, export, render route and associated handoff action entry point removed; legacy navigation redirects to settings.
- Visual evidence and selected reference saved; local preview remains open.

---

# Previously recorded component QA

# Compact sub-agent rows

**Final result: passed**

## Target and evidence

- Source visual: `/Users/wytzehemrica/.codex/generated_images/01a0fc7f-a6a3-7f60-89c9-a7a12efbe465/exec-461501cd-c7a8-4981-97b2-1af09c800029.png`.
- Authoritative refinement: smaller marks; one line containing icon, name, elapsed runtime, cumulative tokens; much less space.
- Implementation screenshot: `/private/tmp/gyro-subagents-compact.png`.
- Preview: `http://127.0.0.1:1420/subagents-fixture.html`.
- Source pixels: 1448 × 1086. Implementation pixels and CSS viewport: 855 × 749, density 1. The source is a larger conceptual mock; full-screen proportions are not a pixel-fidelity target. Comparison focuses on the marks and agent rows, adjusted for the explicit density refinement and existing product typography.
- State: dark theme, three agents, first agent running and selected, its process visible on the right. Additional Environment and pending-approval states inspected.
- Both source and implementation were opened together in the same comparison tool input. Full-view comparison checked hierarchy and integration; focused inspection used rendered DOM bounds and the readable agent rows in the screenshot.

## Findings and comparison history

- Initial browser inspection showed metrics spread across the full chat width. Restricting row width to its content placed runtime and tokens beside the name.
- A first width adjustment constrained all rows to the same intrinsic width and unnecessarily truncated the longest name. Individual content-width rows fixed that; final screenshot shows complete names in the working process.
- Post-fix measurements: each row is 22px tall; its mark is 10 × 10px; text shares a single 16px line. No horizontal overflow in the working-process or 286px Environment list.
- No actionable P0/P1/P2 differences remain within this component scope. Differences from the source's large two-line rows, section heading, and larger icons implement the user's explicit refinement.

## Required fidelity surfaces

- Typography: existing product font retained, 12px names at weight 500, 11px tabular numeric metrics. Names truncate only when space requires it; metrics do not wrap.
- Spacing: 3px vertical padding and 7px element gaps; 4px section margins. No extra heading, count, status line, or chevron in normal list rows.
- Colors: existing product foreground, dark surfaces, muted metadata, hover and selected states retained. Each agent's mark has a stable color across its row and detail panel.
- Asset quality: generated transparent two-color PNG, rendered at 10px in rows and 12px in the panel. No custom vector or CSS drawing substitutes; no visible background box or halo at display size.
- Content: order is mark, agent name, elapsed runtime, cumulative tokens. Estimated and unavailable usage retain their existing labels. Status remains available in the tooltip and detail panel. Pending approvals retain their action controls.

## Verification

- Live runtime and tokens changed in the browser fixture.
- Clicking a working-process row opened the corresponding agent's panel.
- Environment rows use the same compact component and fit its narrow width.
- Pending approval showed its action controls in the parent process and agent panel. The fixture's approval callbacks are stubs; backend approval behavior was not re-exercised for this presentation-only change.
- Browser warning/error logs: none.
- UI TypeScript check and sub-agent, companion, and workbench checks passed.

## Implementation checklist

- [x] Small color mark with stable per-agent identity.
- [x] One compact line per agent.
- [x] Live elapsed time and cumulative tokens retained.
- [x] Row selection and pending-approval presentation preserved.
- [x] Rendered implementation inspected and final evidence captured.

final result: passed

## Named agent process tabs

- Latest target: the existing Gyro chat Working process, with a minimal individual agent tab for each opened process.
- Evidence: `/private/tmp/gyro-agent-tabs.png`, 855 × 749 pixels at the default 855 × 749 CSS viewport, density 1. The same capture contains normal chat work on the left and agent work on the right for direct comparison.
- Typography, spacing, and colors: both timelines render through `ChatRun`; measured call rows share the same 13px font, 20px line height, 26px row height, and muted text color. Normal markdown response blocks and approval cards are reused. Task stays folded, tokens and Stop share the process header, and the name appears only in its tab.
- Tabs use the existing 10px raster marks, quiet native dock styling, capped labels with full-name tooltips, and horizontal scrolling. Each tab has its own close action; closing preserves the underlying agent. Open tabs and selection are scoped to the parent chat and pane.
- Verified: multiple agents, deduplicated reopening, active/inactive tab closure, final-tab closure, keyboard arrows, focus after closure, completed results, failed results, Stop, live usage, pending and resolved approvals, mixing agent tabs with Files, and both light/dark themes. Agents remain absent from the tool picker. No horizontal overflow in the process body.
- Fixes from inspection: the replay lacked the production theme attribute, so it missed normal timeline styling; it now uses the production theme selectors. Capability approval cards ignored resolved status; they now show Approved/Rejected and remove decision buttons. The preview now retains its React root during hot reload instead of mounting duplicates.
- UI and desktop TypeScript checks, sub-agent state checks, companion checks, chat-run checks, workbench checks, and whitespace checks passed. Browser replay verifies presentation and routing; no live provider call was made for this UI change.
- No actionable visual issues remain in this scope. Final result: passed.


---

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


---

# Compact Browser activity and AI pointer — October 10, 2026

**final result: passed**

- Selected source: `docs/design/browser-activity/reference.png`. Production component evidence: `pointer-dark.jpg`, `narrow-light.jpg`, `pointer-detail.jpg` in that directory. Full-context and focused comparisons: `comparison.jpg`, `strip-comparison.jpg`; both were visually inspected.
- One 33px browser activity row, actual tool text and an explicit Stop control. The AI cursor remains visible for six seconds, marks clicks, follows the drag destination, respects reduced motion and hides/restores during model screenshots.
- Scoped report: [Browser activity design QA](docs/design/browser-activity/design-qa.md), including source dimensions, density normalization, intentional product constraints, fixture repair, fidelity surfaces and verification.
- Browser interaction, dark/light and 320px layout checks passed. UI/desktop TypeScript, pointer behavior checks, browser capabilities, hidden-browser input and host bounds passed. Cargo compile/build and the isolated 13-step native Browser smoke passed. The language-server smoke was skipped.
- The installed app bundle remains unchanged; the native change requires rebuilding/reinstalling Gyro.

---

# Compact sub-agents — October 10, 2026

**final result: passed**

- Scoped report: [Sub-agent design QA](docs/design/subagents/design-qa.md).
- Corrected Image Gen source: `docs/design/subagents/reference.png`; combined source/component comparison: `comparison.png` in that directory. Browser evidence covers light/default, dark/small/compact, large/custom-accent and refresh failure.
- Colored identity dots match summaries, rows and process tabs. Environment includes Working/Done filters with measured counts; process metrics remain in the detailed panel. Known agents survive refresh failures with Retry and disclosed diagnostics.
- Approve for me permits delegation within policy limits and releases eligible waiting requests. Full access retains its normal-run override; explicit denials, child inheritance, Plan and Council ceilings are preserved.
- Type checks, production build, relevant UI guards and native delegation/policy tests passed. Live provider spawning was not exercised; the installed app bundle remains unchanged.

Sub-agent composer refinement: strip/composer edges match at regular and narrow widths; the strip's bottom divider is removed. Evidence: `docs/design/subagents/composer-aligned.png`. Workbench/token checks passed.
