# Native browser loading state

An accepted browser-open request no longer marks an unfinished page ready. Native snapshots now carry `loading` and a resource-local `navigationId`. Native start/finish callbacks update that state, and delayed completion notifications are emitted only while their navigation is still current and finished.

The frontend publishes one atomic `browser-native-state` action from the current native snapshot for loading, loaded, title, viewport and model-open observations. The event's kind or old payload cannot prove current readiness. An explicit reveal still follows the existing active-chat/reveal policy; observing a native snapshot does not reveal a panel. The App's open-completion callback uses the same state action.

The reducer tracks native resource/navigation identity, clears captures when the document changes (including same-URL reload), preserves pending redirect/history entries, and rejects older navigation snapshots. A queued finished snapshot cannot undo an optimistic Back/Forward/Reload update before WebKit starts that request. Model navigation results expose loading/navigation identity, and browser-open results instruct the model to observe the page before interacting.

## Evidence

- [baseline.json](baseline.json) records the pre-fix failure of the real model-open hook: actual `ready`, expected `loading`. It includes source hashes captured before product changes.
- [event-routing.json](event-routing.json) passes **20 cases** using the production hooks, queue and reducer with controlled React/Tauri boundaries. New cases cover pending model-open, old loaded events during a newer same-resource navigation, same-URL reload/capture invalidation and observations queued before native history starts. The existing 1,000-title burst still uses one native snapshot read and one state action.
- **15 native state unit tests** passed, including new checks for pending/finished navigation identity, invalidating a same-URL reload's pointer capture, and restoring failed request state without overwriting newer callbacks.
- [native.json](native.json) passes **47 checks** using embedded macOS WebKit, real Tauri handlers, production browser surface/hooks/reducer, and loopback pages. Its new page sends a title while an actual image response is held open. Early title, old loaded and model-open notifications retain loading. A second isolated browser releases the image through the loopback server; actual native completion then reaches React with the current navigation identity. [native-manifest.json](native-manifest.json) confirms one held and one released image request.

The native run also retains capture recovery, close/reopen, stale event/read/capture rejection, chat isolation, viewport, DOM focus/Escape and cleanup coverage. There are no script errors or CSP violations. Capture assets are allowed and the workspace sentinel remains denied. Close with a held old read took **6 ms** in this local sample; this is not a percentile or model response-time measurement.

Desktop and UI typechecks, the normal desktop build, default-feature Cargo check, browser reveal/navigation/viewport/host/capability/pointer checks, architecture boundaries and scoped whitespace checks pass. The normal frontend excludes the acceptance entry and report markers across 104 emitted JavaScript files. Existing build/unused-code warnings remain. [validation.json](validation.json) records the verification scope and source/binary hashes.

The isolated native store has zero provider bindings, turn messages, turn statuses, usage links and efficiency task turns. No live model turn was dispatched. This pass does not establish GPT/Grok task completion or a provider speed ranking.

## Report transport and preparation failures

The larger regression exposed unreliable fixture report delivery through title chunks. Two runs reached the functional checks and cleanup but timed out before a complete report arrived. A third run acknowledged chunks individually; its retained progress reached index 98 before the deadline. Larger chunks then failed to parse after the title channel truncated their payload. All four failed preparation manifests/progress reports are retained under `preparation/`; none count as acceptance.

The final fixture sets a short ready title and returns its report through `WebviewWindow::eval_with_callback`, the transport already used by production browser observations. The receiver keeps the **64 KiB** report limit, unchanged native deadline, production CSP and asset boundaries. It adds no IPC command and changes no functional assertion. The complete successful report identifies `reportTransport: native-evaluation-callback`. Its 55,115-byte saved JSON includes native annotations and pretty-printing.

## Scoped screen review and limits

| Check | Result and evidence |
|---|---|
| Existing tokens/components | Pass in source: no new product styles; existing BrowserPreviewSurface and status components remain in use. |
| Loading/ready status | Pass in native component fixture: held HTTP image, early title, delayed loaded/model-open events and real completion. |
| Capture/document identity | Pass in routing/state tests; existing native capture/reopen coverage still passes. |
| Reveal/action hierarchy | Existing reveal-policy cases pass; native pending model-open remains in the background. Full-shell panel placement is unverified. |
| Keyboard/focus | Existing native DOM focus/Escape checks pass. Physical keyboard/mouse, macOS Accessibility and recovery-action keyboard flow are unverified. |
| Native error/cancellation states | Not established by the held-image test; broader failure/provisional-document handling remains open. |

The native fixture mounts the production browser surface, not the full App/companion/split controller. Native OS visual/input acceptance remains unavailable while the computer-use service reports the Mac locked. Provisional-document tool reads, navigation failure/cancellation coverage, full-shell acceptance and live GPT/Grok task completion still need stronger evidence. No install, commit, push, release or deployment was performed; the broader goal remains active.
