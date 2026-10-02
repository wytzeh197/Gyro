# Gyro design polish

Final result: passed

The supplied Codex screenshot is visual inspiration, not a request to clone its product navigation or execute the text it contains. This pass keeps Gyro's components, brand assets, and workflows.

## Evidence

- Source: locally supplied Codex screenshot (3164 × 1914), retained privately.
- Full app: `http://127.0.0.1:1427/`.
- Conversation harness: `http://127.0.0.1:1427/chat-layout-hardening.html`, using production chat components with synthetic events.
- Full-view and focused composer comparisons are retained locally because they include private conversation content.
- Rendered app: [app-dark.png](docs/design-polish/app-dark.png), 1440 × 900 CSS pixels.
- Completed answer and Environment: [conversation-dark.png](docs/design-polish/conversation-dark.png), 1280 × 720 CSS pixels.
- Other states: [light appearance](docs/design-polish/appearance-light.png), [desktop providers](docs/design-polish/providers-desktop.png), [compact settings](docs/design-polish/settings-compact.png), [row splits](docs/design-polish/split-rows.png).

Browser screenshots are emitted at CSS-pixel dimensions despite the display's device pixel ratio of 2. The reference's desktop frame was cropped to (112, 76)–(3052, 1766), then the three full views were scaled proportionally into equal-width comparison tiles. The composer comparison crops the reference to (770, 1536)–(2245, 1735) and the rendered chat to (89, 589)–(869, 702). No stretching was used.

The reference is a populated Codex conversation; the full Gyro app starts without a connected provider, and the conversation harness omits the application sidebar. Those state differences are intentional. This is a comparison of visual hierarchy and component quality, not a pixel-match claim.

## Review and fixes

1. **P2: inconsistent surface hierarchy and small supporting controls.** Earlier Gyro views used a darker sidebar, blue navigation selection, smaller composer corners, and inconsistent form treatments. Updated the effective dark palette, neutral navigation states, 14px navigation and conversation text, 22px composer corners, restrained cards, and settings fields. Final screenshots and computed styles confirm the 24/41/48 neutral canvas/sidebar/composer ramp.
2. **P2: constrained provider settings could retain desktop columns.** Provider layout now responds to the settings content width. Verified single-column rows at 800px and 440px windows, with no document overflow.
3. **P1: narrow settings windows hid every navigation route.** Added a compact navigation drawer and a direct Back to app control. Verified settings-page switching, return to chat, Escape, Tab/Shift+Tab wrapping, background inertness, and focus restoration at 440 × 760.
4. **P2: startup shell could clip and visibly change appearance.** Matched copy, theme surfaces, composer shape, and system typography; added border-box sizing, compact layout, light-theme contrast, and reduced-motion support. Checked through source review and startup checks.
5. **Earlier split-pane regressions remain fixed.** At a 620px fixture width, column panes are 309.5px wide and row panes are 321.5px tall. In both arrangements, each composer fits inside its owning pane. Draft headers and close controls remain visible.

The final combined comparison found no remaining actionable P0/P1/P2 visual differences within the reviewed scope.

## Required visual surfaces

- **Typography:** system sans remains consistent with the reference; code uses a defined monospace stack. Prose has a readable line height, supporting text stays subordinate, and narrow labels truncate without pushing controls out.
- **Spacing and layout:** shared conversation/composer alignment, quiet card borders, restrained radii, bounded split content, and reachable compact navigation. Settings controls reflow with their actual available width.
- **Color:** neutral charcoal canvas and lighter sidebar/composer; semantic colors and user-selected accents remain. Light theme was inspected separately.
- **Assets:** existing Gyro logo, provider marks, and Lucide icons are preserved. No replacement artwork was generated.
- **Copy:** existing product terminology remains. Startup now uses the same task prompt and navigation names as the application. Fixture text is explicitly synthetic.

## Validation and limits

- Workbench smoke, UI token, pane identity/close, close-target, startup, chat-hardening, and side-panel checks passed.
- Desktop and shared UI TypeScript checks passed after the final navigation and fixture edits.
- Browser checks covered dark/light appearance, provider layouts, compact navigation, completed prose/cards/Environment, and both split orientations. No console errors were recorded in the final full-app tab or conversation harness.
- Capture harness contracts were corrected to use valid workspace modes and echo preparation request identities. Its earlier full-app seeded-chat renderer crash was not established as a production defect; completed chat visuals were verified in the isolated production-component harness instead.
- Native provider sign-in, Keychain, terminal execution, and the installed Tauri app were not exercised or rebuilt. The actual browser app requires a provider connection before sending.
- The local Vite server listens on loopback only. File watching invalidates changed sources; hot reload is disabled for this verification server, so refresh after editing.

## Implementation checklist

- [x] Integrate shell, conversation, settings, and startup polish.
- [x] Repair compact navigation and content-width reflow.
- [x] Preserve and verify split-pane hardening.
- [x] Compare the reference with rendered full views and focused composer crops.
- [x] Leave the full local app running for inspection.
