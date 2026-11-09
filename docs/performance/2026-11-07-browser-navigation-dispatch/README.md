# Guarded browser navigation dispatch — 2026-11-07

Cancelled queued navigation no longer executes after its caller stops. Navigate,
Reload and opening an existing browser check cancellation, deadlines, resource
ownership and the current navigation reservation on the native main thread.
Viewport and scroll-preservation waits now use the same bounded cancellation
mechanism. Native screenshot recovery was also visually verified after the Mac
was unlocked.

## Reproduction and fix

The negative control held the native main thread with a bounded fixture barrier,
queued a real production navigation, then cancelled its model operation. The
caller did not return within 500 ms. Once the fixture released the main thread,
the old implementation returned success, the server received one request and
the actual WKWebView changed to the cancelled destination. All four new checks
failed; the preceding 64 navigation/recovery controls passed. See `baseline.json`.

Navigation previously posted Tauri's native request before waiting for layout.
That queued request had no cancellation guard, and viewport waits used a plain
eight-second channel timeout. The fix dispatches the request inside a guarded
main-thread callback, where Tauri executes it synchronously. A newer navigation
reservation also invalidates an older queued request. Layout bounds and zoom are
applied together after checking cancellation and resource ownership.

An undispatched request can restore a known previous document and native finish
token. It cannot overwrite a newer request or a replacement resource. If the
previous state was an unbound pending request, it reports recovery instead of
restoring an indefinite loading state. Already dispatched actions can still run;
their cancellation does not promise rollback.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Native navigation, recovery and cancellation | 83 passed | `native-navigation.json` |
| Native React/component/hooks/reducer/IPC regression | 53 passed | `native-frontend.json` |
| Native visual review plus the remaining frontend suite | 53 passed | `native-visual-review.json` |
| Rust browser regression tests | 57 passed | `browser-tests.log` |
| Nine browser regression scripts | Passed | `browser-regressions.json` |
| Default-feature Cargo check and desktop TypeScript | Passed | `cargo-check-default.log`, `desktop-typecheck.log` |

The final native run returned cancellation in 22, 22, 24 and 28 ms for navigate,
reload, browser reuse and viewport changes respectively. These are four individual
controlled samples, not a latency distribution or a model-response benchmark.
The actual document/viewport and resource metadata were preserved. End-of-run
server assertions confirmed zero requests to cancelled/replaced destinations.
An older queued navigation failed while its newer replacement loaded the correct
document. All 16 installed navigation observers were detached and released.

All runs used explicit temporary Gyro stores. The five provider-binding,
turn-message, turn-status, usage-link and efficiency-turn tables in the final
native stores remained empty. No model turns were dispatched. Rust tests also
used an explicit `GYRO_TEST_DATA_DIR`; attachment fixture directories were cleaned.

## Native visual review

The review used a temporary app bundle around the locally compiled debug fixture
so native accessibility could identify it independently of installed Gyro apps.
Its production browser component, private image protocol, hooks, reducer and IPC
remained active. No installed application was changed.

Native accessibility and screenshots showed “Screenshot unavailable,” an enabled
“Take new screenshot” action and disabled feedback. A native UI click on that
action displayed a newly captured page, removed the error and enabled “Comment
on page.” Continuing acceptance completed all 53 checks and the temporary app
exited successfully.

![Missing capture recovery state](/Users/wytze/Gyro/docs/performance/2026-11-07-browser-navigation-dispatch/screenshot-unavailable.png)

![Recovered capture and enabled feedback](/Users/wytze/Gyro/docs/performance/2026-11-07-browser-navigation-dispatch/screenshot-recovered.png)

The initial standalone review could not be selected reliably as a separate app.
The first bundled attempt then exposed a fixture assumption: it required an image
width of exactly 390 pixels even though the actual PNG and its native metadata
both reported 389. The corrected fixture checks the decoded image against the
capture's recorded width and height. The nominal preset assertions remain 390 ×
844. In the successful visual run the first PNG was 389 × 844 and its replacement
390 × 843; exact native preset geometry therefore remains a separate open item.
Failed attempt reports and logs are retained.

## Scoped screen review

| Review | Result |
| --- | --- |
| Existing product components/tokens | Pass: unchanged `BrowserPreviewSurface`, capture recovery view and existing `--gyro-*` styles. No new CSS tokens or visual variants. |
| Missing-image and recovered states | Pass: observed in native accessibility and saved screenshots. |
| Truthful status and feedback availability | Pass: error cleared after image decode; feedback changed from disabled to enabled. |
| Action hierarchy | Pass for the recovery state: one existing “Take new screenshot” action. Fixture header controls are test scaffolding. |
| Native input | Recovery action and Continue acceptance were activated through native UI automation. |
| Keyboard/focus rendering | Unverified: Tab/Option-Tab were attempted, but a reliable button traversal or visible focus sequence was not established. No OS keyboard settings were changed. |

## Limits and next acceptance work

This is an isolated debug fixture, not the full App/companion/split shell or an
installed release. Production CSP and private capture boundaries were retained;
the workspace asset sentinel remained inaccessible. Native click verification
covers screenshot recovery, not all browser interactions or accessibility paths.

Fresh browser creation cancellation, complex redirects and superseded native
start callbacks, real post-commit interruption, before-unload decisions, exact
viewport geometry and full-shell keyboard/input acceptance remain open. The
hidden fixture also reported a nominal 800-pixel viewport height while the
read-only DOM oracle observed 768 pixels; cancellation preserved that actual
viewport but does not prove its requested dimensions. Audit close/reopen between
native view lookup and resource capture as a separate concurrency case.

Live GPT/Grok task completion and response speed remain unverified. The earlier
live benchmark remains inconclusive. No install, commit, push, release or
deployment was performed. `validation.json` records source hashes, temporary
roots, raw counts, isolation, visual evidence and remaining work. Unrelated dirty
work was preserved.
