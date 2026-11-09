# Native browser frontend acceptance

The production browser surface, hooks, reducer, queue and Tauri browser handlers now pass a real embedded WKWebView fixture. The successful run contains 33 checks with no script errors or CSP violations. This closes the native component/IPC evidence gap from the [frontend event-routing pass](../2026-11-07-browser-event-routing/README.md).

## What ran

`pnpm test:browser-events-native` builds an explicit Vite entry into a temporary frontend directory, then builds the dedicated `gyro-browser-events-smoke` debug binary with the `native-browser-events-smoke` feature. The library initializes its production browser managers and command handler. The fixture startup returns before normal shell warm-up, provider/automation startup, or the main App component. It creates two sessions in a temporary store and loads the production BrowserPreviewSurface and hooks at `tauri://localhost/`.

The fixture exercises real Tauri event delivery, native browser creation/closure, snapshots, viewport changes and PNG capture. Its loopback HTML pages have distinct titles. It operates the actual rendered viewport and screenshot controls with DOM clicks, and tests DOM focus and the address field's Escape handler. No OS mouse/key gesture is synthesized.

The successful checks cover:

- Empty and populated production browser rendering, native URL/title propagation and rendered URL toolbar state.
- The Mobile button changing both native and React state to 390×844, including its pressed state.
- A real native PNG decoded and displayed by the production capture view, with the owning browser resource ID retained.
- Close/reopen while a real native snapshot result is held by the fixture: native closure and replacement loading finish before that old result is released.
- Stale load/title/viewport/opened notifications rejected through the actual native event bus; four stale observations return false.
- Current notifications using current native snapshot values, separate chat state, and explicit reveal updating the real reducer's panel preference.
- A held real screenshot result discarded after the next close/reopen; the replacement capture state stays empty.
- Both native browser resources closed at the end.

The held results are explicit fault injection after genuine native commands complete. Command responses are not fabricated. The event probe waits for the production observer's returned promise and a normal-priority React commit marker before reading state. `native.json` retains observations and dispatch traces.

## Result and limits

The successful run measured **3 ms** from requesting Close to native closure and React idle state while the old snapshot result remained held. This is one local sample, not a percentile, provider response time, or a claim about a hung browser-creation operation. The [native mobile PNG](native-mobile-capture.png) is retained alongside the report.

The native fixture used the production CSP unchanged. Because its private store lives in a temporary directory, its asset scope maps the normal captures/attachments boundaries onto that temporary store. The report confirms its capture asset is allowed and an existing workspace sentinel is denied. Normal tauri.conf.json permissions were not edited.

The isolated store contains zero provider session bindings, turn messages, turn statuses, usage-turn links and efficiency task turns. No live model call was dispatched. The prepared GPT/Grok rerun is still awaiting additional usage authorization.

This fixture mounts the production browser component and hooks, **not the full App shell or companion/split-layout controller**. Reveal assertions verify reducer preferences; they do not prove whole-shell panel placement. Actual macOS Accessibility permissions, native OS input gestures, clean-machine behavior and provider-driven browser use remain unverified. Image-file decode failure recovery also remains open: the first preparation run exposed that a capture record can exist while its image is unavailable to the renderer; correcting the test asset scope made the valid PNG render, but did not add a product error fallback.

## Preparation failures retained

Four incomplete preparation runs are retained under `preparation/` rather than treated as successful acceptance:

1. The first used the production user-store asset paths with a temporary fixture store. Native screenshot creation succeeded; the capture image could not load from that out-of-scope path.
2. Subsequent probes reached explicit reveal but read React state before its deferred commit. Event delivery acknowledgement alone did not order the production hook's work, and a forced synchronous render could skip normal-priority updates. The final observer/commit acknowledgements fix the fixture. Dispatch traces showed the expected reveal action; no product reveal-policy change was needed.

The runner validates both process completion and the native report's `passed` flag, engine/origin, check count, CSP, error lists and asset scope. A process exit alone is insufficient acceptance evidence.

## Verification and scoped screen review

The normal desktop TypeScript check, the 16 event-routing cases, architecture checks, focused formatting and whitespace checks pass. The normal desktop Vite build and `cargo check --locked -p gyro-desktop --lib` pass with the acceptance feature disabled; existing chunk-size and unused/dead-code warnings remain. The normal frontend has no fixture HTML or fixture script markers across 104 emitted JavaScript files.

| Check | Result | Scope |
|---|---|---|
| Existing design tokens/components | Pass in source | Production BrowserPreviewSurface/viewport/capture components and `--gyro-*` tokens reused; no product style changes. |
| Empty/populated state and current status | Pass in native component fixture | Real reducer, native metadata and rendered URL/viewport controls. |
| Capture rendering | Pass in native component fixture | Actual native PNG, asset protocol and production capture view. |
| Stale async state | Pass in native component fixture | Old event/read/capture outcomes cannot populate the replacement. |
| Focus/keyboard | Pass for DOM behavior only | Focus and Escape handler in native WebKit; physical keyboard/AX input unverified. |
| Whole-shell layout/action hierarchy | Unverified | App, companion dock and split-layout controller not mounted. |
| Missing-image error recovery | Open | Existing capture view has no explicit decode-failure recovery; no success claim for that state. |

`validation.json` records the source hashes, store counts and verification boundaries. No install, commit, push, release, deployment or additional provider usage was performed. The full model/tool-use, browser, response-speed and reliability goal remains active.
