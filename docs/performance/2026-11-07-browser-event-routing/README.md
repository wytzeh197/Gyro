# Browser frontend event routing

The previous backend pass rejected stale browser work, but the React listeners still accepted notifications by chat ID alone. An old `loaded`, `title`, `viewport`, or model `opened` payload could change a replacement browser's UI or reveal a panel. Async UI command results and screenshot completion could also arrive after Close.

## Change

The desktop now shares a native browser queue between open/close handlers and both event listeners. Notifications require a resource ID, fetch the current native snapshot, and apply metadata only when both chat and resource IDs match. URLs, titles and viewport values come from that snapshot instead of the queued event payload. An invalid or missing resource does not reveal the Browser panel.

User open and close requests advance a per-chat generation. Older successes and failures cannot update the UI. Open/close operations remain ordered so a delayed open cannot complete after its requested close and leave an orphaned browser. Normal commands, event observations, viewport changes and screenshot completion keep their original generation. Close waits only for prior creation/closure work, and a new generation drops the old ordinary-work queue. A hung history request or snapshot therefore cannot delay Close or the replacement browser's metadata. No already-dispatched native action is rolled back.

The model reveal policy is preserved: background browsing stays in the background; an explicit reveal request can open the active chat's Browser panel. Inactive chats keep their own browser state. Unmounting either listener suppresses its pending callbacks. Same-kind event bursts retain only their latest queued observation. Current screenshot errors remain visible, while cancelled old screenshots produce neither a capture card nor a new attachment request.

## Evidence

Run `pnpm test:browser-event-routing`. It executes the production event hooks and the screenshot callback extracted from App.tsx, using the real workbench reducer and controlled React/Tauri boundaries. The 16 cases cover stale and untagged events, snapshot ownership, real current values, reveal policy, close during pending snapshots, close/reopen ordering, late errors, independent chats, event bursts, unmount, viewport completion, and screenshot success/failure after Close.

The original hooks from HEAD fail the same stale-event case with `GYRO_BROWSER_EVENT_BASELINE=1`. That expected failure is retained in `baseline.txt`. An intermediate queue design also failed the added stuck-read check: it waited for an unresolved observation before closing. The final design passes that check with both an unresolved observation and an unresolved ordinary command. The new browser's loaded state becomes ready before either old promise is released.

The burst fixture sends 1,000 title notifications through the actual hook. The final implementation makes one native snapshot read and dispatches one workbench action. This is an operation-count result for a synchronous fixture burst, not a provider latency measurement or a native event-rate percentile.

The desktop TypeScript check and Vite production build pass. Existing Vite chunk-size warnings remain. The browser reveal, navigation, viewport, host visibility/bounds, capability, subagent isolation, observation budget and surface-boundary checks pass. The new case is included in `test:reliability`; the whole repository suite was not run. `routing.json` and `validation.json` retain the focused results.

## Scoped screen review

The affected block is Gyro's existing Browser companion: native page host, URL/title toolbar, viewport controls and capture view. Its current components and `--gyro-*` tokens were inspected; no new component, style, token or product decision was introduced.

| Check | Result | Evidence |
|---|---|---|
| Tokens and component consistency | Pass for source scope | Existing BrowserPreviewSurface, BrowserViewportControls and browser-panel-design.css remain in use; changed files add no styling. |
| Empty/closed state | Pass in controlled runtime | Closing during an in-flight event or capture leaves the real reducer's browser empty. |
| Populated/current state | Pass in controlled runtime | Valid notifications use the current snapshot's URL, title and viewport. |
| Loading and command ownership | Pass for covered transitions | Pending old open cannot publish success after Close; close/reopen remain ordered; a replacement is not held up by an old read. |
| Error state and status truth | Pass for covered transitions | A current capture/viewport error is reported; stale errors are suppressed; events from an old resource cannot mark its replacement ready. |
| Action hierarchy and status colors | Not applicable to this change | No controls, labels, variants or colors were changed. |
| Keyboard/focus and rendered appearance | Unverified this pass | No rendered or native frontend keyboard session was run. |

## Limits and next work

The tests control transport and hook lifecycles; they do not mount React in a browser, render screenshots, or prove native IPC delivery in the desktop shell. The earlier [WKWebView backend fixture](../2026-11-07-browser-resource-ownership/README.md) is separate evidence and does not prove this frontend path. Native shell acceptance, same-resource navigation/ready-state ordering, OS mouse/accessibility behavior and live provider task completion remain open. A close still waits for an in-flight open operation, including its setup and final snapshot read, because otherwise that operation could create or configure a browser after the close.

No additional provider usage occurred. The prepared [GPT/Grok fixture-review probe](../benchmark-gpt-grok-reviewed-2026-11-07.json) remains unrun while its additional-usage question is pending. The full tool-use, browser, speed and reliability goal remains active. These edits are local and preserve unrelated dirty work.
