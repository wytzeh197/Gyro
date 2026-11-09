# Page-initiated browser navigation

Links, forms and page scripts previously bypassed the pending-document boundary. The native negative control held the next response's headers, then successfully read the old page, clicked its old reference, clicked its old button by coordinates and captured its old pixels. For each of the three navigation kinds, the old counter changed **0→2**. [baseline.json](baseline.json) records 18 failed checks across those paths; the earlier explicit-navigation checks and same-document compatibility cases still passed.

The macOS browser now observes `webView:didStartProvisionalNavigation:` and invalidates the current document at the native main-frame load boundary. The previous document cannot supply tools or metadata while the next document is pending. This reuses the resource/navigation leases from the [committed-document pass](../2026-11-07-browser-document-ownership/README.md). A committed interactive document remains usable while its images load.

The new `browser_navigation_observer.rs` wraps the existing Wry navigation delegate. It forwards its selectors and handlers, preserves the delegate's policy decisions, and restores/releases the observer association before closing the browser. Installation checks the owning operation's cancellation/deadline. Cleanup still attempts to close the view if detach dispatch fails. It adds no page-script interception or per-tool DOM polling. No navigation permission or CSP change was made.

## Native verification

`pnpm test:browser-navigation-native` now passes **52 checks** in [native-navigation.json](native-navigation.json):

- Explicit navigation, same-URL reload, actual Back/Forward and eight fast initial documents retain their existing checks.
- Link, form and script navigation reject old reads, clicks, pointer actions and screenshots while actual response headers are held. A separate read-only native oracle confirms that each old counter remains **0→0**. Pending native metadata identifies the next URL.
- After commit, fresh references operate on the new interactive document while an image response is still held.
- Prevented links, SPA routes, fragments, iframe loads and blocked credential URLs leave the parent usable with its existing references. The runner also asserts that the blocked credential URL produces no server request.
- All **13 installed observers** are detached and dropped. The diagnostic counter records **82 forwarding calls** to the existing delegate.

[native-navigation-manifest.json](native-navigation-manifest.json) records five held/released document responses and five held/released image responses. The controls are loopback HTTP, and no native command response is fabricated. The native fixture calls production browser functions directly; it does not dispatch a model turn or exercise the complete broker approval UI.

The separate production-component fixture still passes all **47 checks** in [native-frontend.json](native-frontend.json), including loading state, capture recovery, stale event/read/capture rejection, viewport, chat isolation, DOM focus/Escape and cleanup. It reports no script errors or CSP violations; captures are allowed and the workspace sentinel remains denied. Close with a held old read took **4 ms** in this local sample. This is not a percentile or model response-time measurement.

The wider browser Rust suite passes **53 tests** with an explicit temporary `GYRO_TEST_DATA_DIR`; its scratch attachment directories are cleaned up. The 20 routing cases, capability/observation-cost/subagent/navigation/reveal checks, architecture boundaries, desktop typecheck, default-feature Cargo check, focused formatting and whitespace checks pass. Existing unused-code/chunk-size warnings remain. The two native stores contain zero provider bindings, turn messages, turn statuses, usage links and efficiency task turns. No provider turn was dispatched.

## Evidence corrections and limits

`baseline-initial.json` used an empty pointer coordinate. The final negative control targets the old button itself, proving that the coordinate action also changes the old document before the fix. Both reports are retained.

The first observer run passed its 51 functional checks but inspected teardown counters immediately after queuing Close. It saw 12 of 13 releases. The corrected fixture waits, with a three-second bound, for actual detach/drop completion and still requires exact equality. [preparation/01-pQLilH-browser-navigation.json](preparation/01-pQLilH-browser-navigation.json) retains that incomplete run; the final result is 13/13/13. Product Close remains asynchronous.

This work mounts native browser functions and a production browser-component fixture, not the full App/companion/split controller. Physical OS input, macOS Accessibility, before-unload prompt decisions, failed/cancelled navigation recovery and redirect edge cases need further acceptance evidence. Live GPT/Grok task completion and response-speed measurement remain open. No install, commit, push, release or deployment was performed; the broader goal remains active.
