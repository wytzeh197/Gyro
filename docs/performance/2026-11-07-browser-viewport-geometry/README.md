# Native browser viewport geometry — 2026-11-07

The requested CSS viewport, actual WebKit layout, captured PNG and pointer
coordinates now agree in the native fixture. This fixes the viewport drift left
open by the preceding navigation-dispatch pass. Changes are local against
`1d0b7e1321790246390b9ad64d78f73813a37ab6` plus the existing dirty checkout.

## Reproduction and repair

The negative control failed 24 of 40 checks across eight cases. Wry rounded
fractional child-view sizes to integer native points. WebKit also applied a
titlebar content inset independently of AppKit's safe-area metadata. A hidden
1280 × 800 browser could expose only 1280 × 768 CSS pixels. Merely changing safe
area insets or the WKWebView's own bounds did not repair this; failed attempts
are retained.

| Case                       | Requested   | Previous DOM | Final DOM and PNG |
| -------------------------- | ----------- | ------------ | ----------------- |
| Initial hidden default     | 1280 × 800  | 1280 × 768   | 1280 × 800        |
| Desktop in fractional host | 1280 × 800  | 1279 × 797   | 1280 × 800        |
| Mobile in fractional host  | 390 × 844   | 390 × 843    | 390 × 844         |
| Tablet in fractional host  | 768 × 1024  | 767 × 1022   | 768 × 1024        |
| Custom in fractional host  | 1920 × 1080 | 1920 × 1077  | 1920 × 1080       |
| Responsive                 | 536 × 418   | 536 × 417    | 536 × 418         |

On macOS a separate NSView container now holds the exact fitted panel rectangle.
Its bounds and the WKWebView's frame keep the requested integer CSS size, with
page zoom 1. AppKit transforms drawing and native input together. WebKit's
automatic/top content insets are disabled using selectors checked before use.
These SPI are declared in
[WebKit's native header](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)
and implemented in
[WKWebViewMac.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm).

The container preserves Wry's window-resize anchoring. When its browser is
hidden, an otherwise empty container hit does not intercept React recovery
controls. Chat and private Check close paths detach the native navigation
observer and container. An initial viewport failure also closes the webview.

## Verification

| Check                                                        | Result                                | Evidence                                                       |
| ------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| Native viewport and private Check lifecycle                  | 70 passed                             | `native-geometry-final.json`                                   |
| Independently decoded PNG size and marker coordinates        | 9 cases passed                        | `native-geometry-final-pixels.json`, `geometry-*.png`          |
| Native navigation, failure recovery and cancellation         | 83 passed                             | `native-navigation-final.json`                                 |
| Embedded React/components/hooks/reducer/IPC and PNG recovery | 55 passed                             | `native-frontend-final.json`                                   |
| Native coordinate-input review                               | 66 passed in earlier fixture revision | `native-input-review.json`, `geometry-input-verified.json`     |
| Native screenshot-recovery review                            | 53 passed in earlier fixture revision | `native-recovery-review.json`, screenshots below               |
| Rust browser regression tests                                | 57 passed                             | `browser-tests.log`, `browser-tests-manifest.json`             |
| Nine browser regression scripts                              | Passed                                | `browser-regressions.json`, `browser-regressions-retry.json`   |
| Default-feature Cargo check and desktop TypeScript           | Passed                                | `cargo-check-default-final.log`, `desktop-typecheck-final.log` |

Each geometry case compares caller-side preset expectations with the actual
DOM before and after capture. The pixel checker decodes the PNG, verifies its
size and locates a 12 × 12 calibration marker at CSS (80, 120). All nine final
images have the exact marker rectangle (80, 120)–(92, 132). The test permits one
backing pixel at raster edges; the marker centre must also have the right colour.

The private Check case opens and closes its real hidden native resource at
1440 × 1080. It verifies the page marker, viewport, PNG and resource removal.
It uses a synthetic fixture plan; it does not execute Check actions, consume an
approval or validate the human resolver. All nine installed viewport containers
were detached and released. The original eight geometry cases also verify
background pointer delivery to the marker.

The manual input review used native computer-use coordinate clicks on the fitted
mobile page. The first reached the small marker and changed its colour/counter;
the second finished the review. Saved native accessibility and DOM observations
confirm the result. The generic report's `nativeOsInputTested: false` field
describes the automatic runner; this separate manual evidence is in
`geometry-input-verified.json` and `native-input-verified.png`.

Native screenshot review observed “Screenshot unavailable,” an enabled “Take
new screenshot” action and disabled feedback. A coordinate click activated that
action while the WKWebView was hidden. The newly decoded 390 × 844 capture
appeared and feedback became available. Strict requested-size assertions were
then restored in the final 55-check automated suite.

![Recovered native capture](/Users/wytze/Gyro/docs/performance/2026-11-07-browser-viewport-geometry/recovery-verified.png)

All native runs and Rust browser tests used explicit temporary Gyro stores.
Provider binding, message, status, usage-link and efficiency-turn tables remained
empty in the inspected stores. No provider turns were dispatched in this pass.
Production CSP and Cargo.lock hashes are unchanged; see `source-hashes.json`.
Nothing was committed, installed, pushed or released.

Four regression scripts initially failed because the newly added task-record
module imported a runtime dependency without its `.ts` extension. Adding the
extension allowed all four to pass without changing task behavior. The separate
`check-local-check-browser.mjs` still fails because
`mockups/subagents-2026-10-30/conversation.html` is absent. That legacy mockup
portion is not counted as passing. A first private Check fixture attempt also
served a 404 because the server required a query string forbidden by Check;
the corrected route and explicit marker assertion prevent an empty error page
from passing as the calibration page. Its failed artifacts are retained.

## Reproduction and limits

Run `node scripts/run-browser-events-native.mjs --geometry` for the geometry and
pixel checks, `--navigation` for native navigation, or use
`GYRO_BROWSER_FRONTEND_BUNDLED=1 node scripts/run-browser-events-native.mjs` for
the embedded frontend suite. `--geometry-input-review` waits for native manual
input and requires an unlocked Mac. Each runner creates its own temporary store.
For Rust tests, set `GYRO_TEST_DATA_DIR` to a fresh temporary directory before
running `cargo test --offline --locked -p gyro-desktop --lib browser -- --nocapture`.
Local test servers require loopback access. Build warnings are preserved in logs.

Native acceptance here covers macOS 26.2 with backing scale 1 in a debug fixture.
The final automated runs add Check lifecycle coverage and preserve Wry's resize
mask after the two manual reviews. Retina displays, older supported WebKit
versions, window/display transitions, keyboard/IME, and the complete App,
companion and split-panel shell still require acceptance. The inset selectors
are private WebKit API; unsupported implementations return an explicit error.
This is a compatibility risk to resolve before release.

These results establish local browser geometry and recovery behavior. They do
not establish end-to-end model speed, live GPT/Grok task completion or competitive
model rankings. Additional paid model testing still awaits the requested usage
budget. The broader optimization goal remains active.
