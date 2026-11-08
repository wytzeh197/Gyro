# Browser tools belong to the committed document

The native regression reproduced a real navigation bug: while the server held the next response's headers, `readPage` returned the previous document, `click` changed its counter, and the old read overwrote the requested native URL. Same-URL reload also allowed the previous page's click. [baseline.json](baseline.json) retains that negative control: the old counter changed from 0→1 on navigation and 1→2 on reload. Baseline source hashes are retained separately.

The production native browser now tracks whether the requested document has committed. DOM operations, native screenshots and pointer operations acquire a lease containing both browser-resource and navigation identity. Pending requests reject old-document work before dispatch; queued work and returned observations are checked against that identity again. A dispatched action may already have run when a navigation changes, so its error asks the caller to observe before retrying.

On macOS, the pinned Wry 0.55.1 implementation emits `PageLoadEvent::Started` from `WKWebView`'s `didCommitNavigation` callback. This provides a document boundary without waiting for every image. A committed interactive document remains readable and actionable while resources load. Native Back/Forward uses WebKit's history availability and navigation APIs, marks the request pending, and leaves the current document valid when that history direction is unavailable.

Screenshot observation assembly and pointer-capture registration also validate navigation identity, covering same-URL reloads. A one-time asynchronous check reconciles a fast first page that committed before native slot registration; it rejects `about:blank` and cannot commit a superseded navigation. Open does not wait on this check.

## Native evidence

`pnpm test:browser-navigation-native` runs production native browser functions in an isolated embedded WKWebView, using controlled loopback HTTP responses. It dispatches no model turn and sends no OS mouse/keyboard input.

[native-navigation.json](native-navigation.json) passes **25 checks**:

- Before response headers arrive, page reads, old-reference clicks, screenshots and background pointer actions fail. A separate read-only native oracle confirms that the old document's counter stays unchanged and the requested native URL is preserved.
- After commit, page reads, fresh references and background pointer clicks work while an actual image response remains held. Old-document references fail. Both ordinary navigation and same-URL reload follow this sequence.
- Real Back and Forward reach the expected documents. An unavailable Forward fails without invalidating the current document.
- The browser closes, then eight immediate initial documents are created, read and closed successfully.

[native-navigation-manifest.json](native-navigation-manifest.json) confirms two held/released document responses and two held/released image responses. The baseline used the first 15 checks; the final fixture adds pointer, screenshot, history and fast-initial-page coverage. This is a correctness comparison, not a latency benchmark. Intermediate successful 15- and 22-check runs are retained under `preparation/`.

The separate production-component fixture still passes all **47 checks** in [native-frontend.json](native-frontend.json), including loading state, capture recovery, stale event/read/capture rejection, chat isolation, viewport, DOM focus/Escape and native cleanup. Its CSP remains unchanged, capture assets are allowed, and the workspace sentinel is denied. No script errors or CSP violations were reported.

Both native stores have zero provider bindings, turn messages, turn statuses, usage links and efficiency task turns. The fixtures test native functions and components; they do not prove live provider task completion, broker approval UI, full-shell layout or physical input acceptance.

## Other verification and test isolation

The final wider Rust browser suite passes **51 tests**, including the 18 native state tests. The 20 frontend routing cases, capability/observation-cost/subagent/navigation/reveal checks, architecture boundaries, desktop/UI typechecks, normal desktop build and default-feature Cargo check also pass. Logs and source hashes are retained here. Existing unused-code/chunk-size warnings remain.

One preliminary wider-suite run failed under the sandbox: a listener could not bind and an existing attachment test could not initialize normal Gyro storage. Its first escalated rerun passed, but that attachment test used a disposable fixture in the normal attachment directory. That invocation should have used the test-data override. The test's `TempDir` cleanup completed, and a read-only check found no recent matching scratch directories. The final run uses an explicit temporary `GYRO_TEST_DATA_DIR`; [browser-tests-isolated-manifest.json](browser-tests-isolated-manifest.json) records successful completion and zero remaining fixture directories. The earlier logs are retained and are not the final isolation evidence.

Two source guards in the subagent check were updated to recognize the document-bound pointer helper and the stronger navigation-completion check. Their background/resource requirements remain asserted; the native fixture also verifies valid and rejected background pointer actions.

## Remaining scope

Pending navigation initiated directly by page scripts/forms/links before the native commit callback still needs dedicated coverage; this pass establishes the boundary for Gyro's explicit open/navigate/reload/history requests. Redirect/error/cancellation recovery and live-model handling of pending-document errors need stronger acceptance evidence. Full App/companion/split-shell layout, native OS input and live GPT/Grok task completion/speed remain open. No install, commit, push, release or deployment was performed. The broad goal remains active.
