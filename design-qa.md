# Terminal drawer design QA

final result: passed

Scope: adapt Gyro's existing terminal drawer to the supplied Codex terminal reference. This is an implementation in the existing app; the surrounding editor, sidebar and chat flows are outside the visual-matching scope.

Source visual truth: `/Users/wytzehemrica/Desktop/Screenshot 2026-09-12 at 15.42.06.png` (3164 × 1926 pixels).
Implementation: `docs/screenshots/terminal-codex/drawer-reference-size.png` (1470 × 850 pixels and CSS viewport, 1× capture).
Focused comparison: `docs/screenshots/terminal-codex/drawer-comparison.png`, source above and implementation below. Reference drawer crop (662,1219)–(3052,1775) was reduced from Retina resolution to 1195 × 278; implementation crop (284,550)–(1470,828) is 1186 × 278. The nine-pixel width difference is existing sidebar sizing. No image stretching was applied to the implementation.
Full-view evidence: source and implementation were opened together, then the normalized drawer comparison was inspected. The app window was matched to approximately the source's logical dimensions. Also inspected at the default 842 × 765 viewport (`drawer.png`, earlier iteration).
State: one selected idle terminal, drawer open, light theme. Shell label and empty browser-preview terminal are expected content differences from the reference's Gyro tab and native shell prompt.

## Findings and iterations

- Fixed duplicate workspace-tool header by putting drawer controls in the terminal tab strip. Other tool destinations remain in the existing overflow menu. Empty terminal and non-terminal tool headers retain their navigation.
- Fixed an older CSS rule hiding the drawer toolbar, which initially left the output in a 42px row.
- Fixed a clipped overflow menu by positioning it in available viewport space with scrolling.
- Fixed centered labels and inherited tab padding after focused comparison. The final comparison shows left-aligned icons and labels, compact selected tabs, and a continuous neutral canvas.
- Removed the idle resize grip while keeping hover/focus visibility and the existing resize hit target.

## Fidelity surfaces

- Typography: existing system sans-serif, 13px regular labels; existing terminal monospace retained.
- Spacing: one 42px toolbar, 30px tab, 160px minimum tab width, 8px outer inset; no duplicate heading or toolbar divider.
- Colors: white light-theme canvas and subtle gray active tab, no drawer shadow. Existing dark-theme canvas and tokens remain supported but were not visually tested.
- Assets: existing SquareTerminal, Plus and X library icons; no raster assets needed for this terminal-only scope.
- Content: real terminal labels and controls; no copied reference username or fake shell prompt. Gyro's overflow and maximize controls are intentional product adaptations.

## Verification

Browser: add terminal, switch active tab, close created tab, switch to Output from menu, return to terminal, maximize and restore. Existing terminal state survived tool switching. Menu checked visually within viewport. No browser console errors reported.

Desktop TypeScript check, terminal split-layout checks, workbench smoke checks, and production build passed. The production build used `/tmp/gyro-terminal-design-build-20260912` after a collision in the shared dist directory. The smoke assertion was updated for the new compact-header condition. Browser preview does not exercise a native PTY; terminal execution was not changed.

No remaining P0/P1/P2 visual findings in the requested scope. Native PTY and dark-theme verification remain outside this visual pass.

# Appearance theme picker — 2026-09-12

final result: passed

Source: `/var/folders/tf/yjnx70vd6t54vg3cx_y7vq7h0000gn/T/TemporaryItems/NSIRD_screencaptureui_QfoP3C/Screenshot 2026-09-12 at 15.56.18.png`, 1804 × 654 pixels, approximately 902 × 327 logical pixels at 2× density.
Implementation: `docs/screenshots/appearance-codex/light.png`, 842 × 765 pixels/CSS viewport at 1×. Source and rendered implementation were opened together in the same comparison. The source is a settings-content crop; the implementation includes Gyro's sidebar and its other appearance controls. The narrower content region intentionally scales the three images down while retaining readable 14px labels.

Fidelity review: regular 24px Appearance heading; simple 14px Theme heading; System, Light, Dark order; preview aspect ratio approximately 1.42; rounded 10px corners; neutral colors; labels centered below images; 2px selected outline. Artwork is cropped directly from the supplied reference, excluding its selection border, and uses real image assets. Selection is drawn independently so all three modes can be selected. Copy matches the reference; existing density, color and motion controls remain below the theme group.

Iteration: removed an inherited horizontal divider above the images after the first visual inspection. Final light-theme screenshot was inspected alongside the source; no remaining P0/P1/P2 visual findings. Dark-theme screenshot was also inspected live and its selection outline remains visible. System, Dark and Light selections were exercised and the preview restored to Light. No browser console errors. TypeScript and workbench smoke checks passed; the existing smoke assertions now recognize the mapped theme options rather than requiring the removed helper text and duplicated handlers.


## Project sidebar card — September 12

Source references: `/Users/wytzehemrica/Desktop/Screenshot 2026-09-12 at 16.02.16.png`, `/Users/wytzehemrica/Desktop/Screenshot 2026-09-12 at 16.02.24.png`, and the user's 16.08.12 correction requesting a smaller card without a sidebar settings icon.
Implementation evidence: `docs/screenshots/project-sidebar/card.png` and `docs/screenshots/project-sidebar/dialog.png` (1280×720 CSS pixels, 1× capture).
Reference dialog screenshot: 3164×1930 physical pixels; approximately 2× desktop capture. Compared component structure rather than unrelated app chrome or content. Source and rendered dialog/card were opened together for comparison.

- Typography: existing Gyro font; compact card uses 13px body and 14px heading, consistent with the revised request.
- Layout: card reduced from 360px to 270px wide; tighter rows and 12px corners. Dialog retains the reference's name, folder list, and footer arrangement. No sidebar settings button remains.
- Color: existing light/dark tokens; neutral borders, subtle elevation, muted icons, destructive red removal, dark Save action.
- Assets: standard folder, message, pin, and settings library icons; no raster assets required.
- Copy: real project name, task count, active count and path; reference edit labels retained.
- Browser checks: card displayed, edit action opened dialog, name save updated sidebar. Desktop TypeScript check passed.
- Limits: native folder picker and exact pointer delay were inspected in implementation, not exercised by browser automation. Primary folder stays attached because it identifies the project; additional folders are removable. Remove local project uses the existing removal flow.
- Iteration: original card was too large and had an unwanted row icon; reduced width/text/spacing and removed that trigger, then captured both updated states. No remaining actionable visual findings against the revised request.

final result: passed


## Primary folders and Gyro styling refinement

Source: user screenshot `Screenshot 2026-09-12 at 16.13.01.png` (1138×778 crop) and explicit request to adapt popups to Gyro's design language.
Rendered evidence: `docs/screenshots/project-sidebar/primary-folders.png`, 1280×720 at 1×. Visual comparison uses the dialog region; screenshot crop and app viewport intentionally differ.

Typography and spacing: 13px body, 18px heading, 480px dialog, compact folder controls. Gyro's existing font, radius, semantic danger, focus, surface, and shadow tokens replace custom values. Library folder and close icons remain sharp; no raster artwork is needed. Primary badge and Make primary action retain the supplied hierarchy with smaller Gyro control sizing. Neutral panels, aligned footer, readable folder names and no clipping observed. No actionable visual findings.

Browser verified: add folder (deterministic native-picker fixture), Make primary, Save, reopen with selected primary retained. Unit coverage checks primary-first workspace order and fallback for removed folders; desktop typecheck and workbench checks passed. Real OS folder-picker interaction was not automated.

final result: passed
