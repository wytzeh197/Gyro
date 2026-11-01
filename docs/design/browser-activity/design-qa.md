# Compact browser activity and visible AI pointer

**final result: passed**

The compact browser status treatment is applied to the production `BrowserPreviewSurface`. The page-local pointer uses the same feedback factory in the native injected agent and in the development preview.

## Source and evidence

- Selected visual: `docs/design/browser-activity/reference.png`, 1567 × 1004 pixels; the approved refinement of the first concept.
- Production component preview: `http://127.0.0.1:1420/browser-layout-fixture.html?pointer&theme=dark`.
- Browser-rendered evidence: `pointer-dark.jpg`, 1280 × 720 pixels at density 1. The component is 574 CSS px wide; its strip measures 573 × 33 CSS px inside the border.
- Narrow/light evidence: `narrow-light.jpg`, 1280 × 720 pixels at density 1; the component is 320 CSS px wide and its strip measures 319 × 33 px.
- Full-context comparison: `comparison.jpg`. Both the selected full-app concept and the rendered component fixture were opened together. The fixture intentionally isolates the production browser component; it does not reproduce or replace the sidebar and chat.
- Focused comparison: `strip-comparison.jpg`. The selected strip was normalized from 703 × 44 image px to 573 × 36 px; the rendered strip is 573 × 33 px. Both were inspected in the same image.
- Pointer detail: `pointer-detail.jpg`, cropped from the browser-rendered screenshot without changing its scale.

## Findings and intentional differences

No actionable P0/P1/P2 visual findings remain in the changed component. The small difference in strip height retains the user's request for a shorter single row.

The generated concept's Pause label is Stop in production: the existing callback cancels the current response, rather than suspending a browser session. The activity text is supplied by the actual tool event; the preview uses the explicitly labeled fixture action “Checking page controls.” The static generated spinner is represented by Gyro's existing blue presence marker.

The full-app mock shows a loading webpage. The browser fixture shows a small interactive test page so pointer placement and click feedback can be verified. This is component-rendering evidence, not a live model run. Existing shell, sidebar and composer are outside this change.

## Required fidelity surfaces

- Typography: existing system sans family and UI-size scale. The strip uses 12px text, a medium-weight single-line primary label and muted activity text. Long activity text truncates while preserving the Stop control.
- Spacing/layout: one 33px strip under the address toolbar, an 8px gap, thin separator before the activity and a compact 24px action. No duplicate floating loading pill in chat; routine footer status is hidden when it carries no capture or diagnostic information. Loading replaces the large skeleton with a small existing status indicator.
- Colors/tokens: existing graphite surfaces, foreground, muted text, border and blue accent tokens. Measured dark strip surface rgb(28,28,28), foreground rgb(237,237,237). Light theme is verified.
- Assets: the AI pointer retains Gyro's existing arrow vector with a white outline and blue actor label. No generated assets are used by the UI. The pointer and target indicator are inert, aria-hidden, outside the body-rooted observation tree, and do not consume mouse input.
- Copy: “Gyro is browsing,” the actual activity description and “Stop.” The pointer uses the supplied actor, defaulting to “Gyro.”

## Verification and repairs

The first pointer fixture render failed because a leading JavaScript comment caused the fixture's factory evaluator to return early. That development-only evaluator was repaired and the preview reloaded; the subsequent click screenshot, hide/restore checks and console check pass.

Browser checks: AI click increments the visible counter exactly once and displays the blue pointer on the clicked button; screenshot hiding makes the pointer invisible and restore makes it visible again; Stop removes the activity strip. At 320px in light theme, the strip stays 33px tall, Stop fits and the document has no horizontal overflow. The final fresh render has no console errors or warnings.

Focused behavior tests pass for pointer tip coordinates, persistent cursor reuse, target highlight expiry, six-second cursor lifetime, drag destination, edge label placement, cleanup, reduced motion, and temporary capture hiding. Existing browser capability, hidden sub-agent browser and native host-bounds checks pass. UI/desktop TypeScript checks and native Cargo compile checks pass.

Native integration: passed in the freshly built isolated debug app. The 13-step browser smoke verified a visible cursor after a ref click, capture hide/restore, exactly one click, native hover/secondary-click/canvas click/drag, form interactions, credential/stale-ref rejection, screenshot capture, navigation/history and independent hidden browser input. The first attempt stopped at the foreground guard; the opt-in test harness now explicitly activates its isolated macOS app before focusing the window. Production mouse input still refuses to activate Gyro. The language-server smoke was skipped because it is outside this change.

The installed application bundle is not replaced by this task; applying the native change there requires rebuilding/reinstalling Gyro.
