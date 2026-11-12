# Inline browser annotations

Implemented in source on 2026-11-11.

## Live browser flow

1. Choose **Annotatie** in the browser toolbar. The label collapses to its icon in a narrow panel.
2. Hover over an element. Inline text resolves to its nearest visual card where appropriate; links, buttons, and media remain directly selectable.
3. Click to capture the selected visible region. The click does not activate the underlying page.
4. Type in the bubble beside the captured element and choose **Send**. Ctrl/Cmd+Enter also sends; Enter inserts a newline.
5. The normal chat receives the comment, cropped PNG, and immutable element context. Sending or cancelling restores Live view.

The main composer draft and its attachments remain intact, including when the first annotation creates a new chat. Annotation submission uses the existing send/queue/model/mode path. The bubble closes on durable message insertion or queue acceptance, without waiting for model completion. Duplicate submit events are guarded.

## Selection geometry

The injected selector draws an SVG outline from actual element geometry: individual elliptical corner radii, supported affine transforms, polygon/circle/ellipse CSS clips, and SVG path geometry. Geometry is refreshed while selection is active, including scroll and resize. Up selects a parent; Down returns toward the child. Tab and Enter support keyboard selection; Escape cancels.

Complex or inaccessible geometry uses a dashed bounding outline and the captured bubble identifies it as **element bounds**. This includes unsupported clips, perspective/ancestor transforms where exact quads are unavailable, and non-path SVG internals. Canvas internals and closed shadow contents are not individually inspectable. Embedded frames and form controls cannot be selected directly.

The underlying inspector shares the existing browser ref registry. Navigation or replaced refs cannot silently retarget another element.

## Capture and bubble

Native WebKit capture is bound to the selected browser document. Before and after capture, document identity, viewport, DOM revision, geometry, and detected protected rectangles must agree. Comparisons use field values, not JSON property order.

Selection graphics are removed before capture. The desktop helper maps CSS coordinates into bitmap pixels, clips offscreen regions, masks detected form fields and embedded-frame regions, and creates the PNG crop. The full sanitized viewport is held only for the local frozen view; it is not sent to the model. Capture failure remains an error instead of silently becoming a metadata-only send.

The comment bubble is rendered by Gyro over that captured view, never inserted into the website. It prefers the target's upper-right edge, then left/below/above, and clamps inside the panel. A **Captured** label distinguishes this view from Live. The bubble retains its comment after a send failure.

## Lifecycle and ownership

Commands are serialized per browser session, with distinct selection tokens across effect restarts. Cancel, navigation, panel teardown, and the heartbeat timeout release input interception. Late responses stay attached to their originating chat.

The image attachment uses the normal persisted asset preview URL. The metadata attachment is a `browser-snapshot` containing URL, ref, timestamp, bounds, supported geometry and styles, and bounded visible text framed as untrusted observations. HTML and field values are not serialized.

Existing saved-capture **Select element / Add to chat** and region-comment workflows remain available.

## Verification

- `pnpm --filter @gyro-dev/desktop typecheck`
- `cargo check -p gyro-desktop --locked`
- `pnpm test:browser-annotations`: helper and actual App callback checks plus 24 shipped DOM-agent checks in Chromium.
- `pnpm test:browser-annotations:ui`: eight production-component scenarios covering both themes, wide/narrow toolbar geometry, captured bubble positioning, duplicate submit prevention, errors, Escape, and saved-capture regression behavior. The fixture runs with React StrictMode. Start Vite at port 1431 or set `GYRO_TEST_ORIGIN`.
- `node scripts/run-browser-events-native.mjs`: isolated embedded production frontend, real Tauri IPC and WebKit; 63 checks including native annotation hit testing, PNG capture/crop, bubble focus and containment, persisted image/context attachments, and restoration to Live.
- `git diff --check`

Native selection in the automated check is driven through point hit testing. Chat delivery acknowledgement is simulated there; the actual App send callback is exercised separately with controlled dependencies. No live model/provider request is made by these checks, and the installed application is not replaced.

Screenshots in `artifacts/browser-annotations/`:

- `toolbar.png`: the visible icon + Annotatie toolbar button.
- `hover.png`: the real injected hover outline on a runtime test page.
- `wide.png`, `dark.png`, `light.png`: the production bubble on an explicitly simulated UI fixture.
- `sent-fixture.png`: simulated delivery of the cropped image and comment, not a live conversation.

## Design review

- **Components/tokens — pass:** existing browser toolbar, form controls, surface/text/border/radius/shadow tokens. The selection-blue semantic token matches the existing browser pointer color.
- **States — pass:** selecting, capturing, captured, sending, error/retry, and cancelled; status reflects actual state.
- **Hierarchy — pass:** Send is the bubble's submitting action; close/cancel are secondary.
- **Layout — pass:** tested narrow and wide layouts; the annotation action and options menu occupy one toolbar row.
- **Keyboard — pass:** DOM selection keys, comment focus, Escape and Ctrl/Cmd+Enter; native fixture verifies comment-field focus.
- **Evidence boundary:** browser/UI fixtures and isolated native WebKit are verified. Installed-app manual acceptance and live-provider delivery are not claimed.

Scoped interaction rule: browser annotations begin in a visible toolbar action, keep feedback beside the captured target, and submit the target with the comment. This keeps the user's visual reference connected to the resulting chat instruction; it is not a general rule for unrelated feedback forms.

Unrelated staged and unstaged work is preserved. No commit, push, installation, or release is part of this implementation.
