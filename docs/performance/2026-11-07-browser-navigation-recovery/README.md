# Browser navigation failure recovery — 2026-11-07

Failed and cancelled macOS browser loads now settle with an explicit recovery
state. Try again requests the attempted destination; Back can recover the
previous document after a provisional failure. Tools cannot read, click or
capture that old document until the user explicitly recovers it.

The negative control used a loopback server that destroyed the connection before
response headers. The actual WKWebView remained on the original document while
Gyro stayed `loading: true`, `documentCommitted: false`. After three seconds,
tools still returned “waiting for the new document.” Two of 55 checks failed;
the existing document-ownership controls passed. See `baseline.json` and
`baseline-manifest.json`.

## Changes

- The native navigation observer receives commit, finish, provisional failure
  and post-commit failure callbacks as well as start. It forwards Wry's existing
  delegate handlers and remains detached/released on close.
- Browser state matches terminal callbacks to their native navigation token.
  Explicit requests invalidate the previous token before dispatch. Unit coverage
  includes stale failures, commits and finishes during a same-URL reload.
- A failure exposes a safe error kind/message/code, clears the loading state,
  and prevents old or partial document tools and screenshots from appearing
  successful. Raw localized WebKit error text is not shown.
- Retry navigates to the failed URL instead of reloading WebKit's retained old
  document. Back explicitly recovers that document after a provisional failure
  or cancellation; post-commit failure still uses native history.
- The existing browser error placeholder shows the current message and Try again
  action. The old native child is hidden so it cannot cover the controls. Failure
  also clears a screenshot captured during a partial load.

## Evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Native WKWebView navigation | 64 passed | `native-navigation.json` |
| Native React/browser component, hooks, reducer and IPC | 53 passed | `native-frontend.json` |
| Focused Rust browser regressions | 55 passed | `browser-tests.log` |
| Event routing and reducer cases | 21 passed | `event-routing.log` |
| Reveal, observation, private browsers and Chromium DOM agent regressions | Passed | `browser-regressions.log` |
| Desktop TypeScript and default-feature Cargo check | Passed | `desktop-typecheck.log`, `cargo-check.log` |

Native cases include actual connection failure, repeated failure, failed initial
page, unavailable initial Back, Retry to the correct URL, native cancellation,
Back after cancellation, and replacing a held load without inheriting its
cancellation. The earlier link/form/script, history, iframe and same-document
controls remain covered. All 15 installed native navigation observers were
detached and released.

The frontend fixture rendered the real failure message, observed the old child
become hidden, focused the existing Try again button and clicked it through to a
successful load of the failed URL. These were DOM focus/click checks, not OS
keyboard or pointer input. A reducer regression verifies that a capture taken
during loading is cleared even when failure keeps the same navigation identity.

Each native run and the Rust suite used an explicit temporary Gyro store. The
five provider-turn/binding/usage tables in both final native stores remained
empty. These tests dispatched no model turns. The Chromium check initially
could not start within the restricted sandbox; it passed with loopback/headless
access. Two initial fixture compilation errors were corrected before the final
successful builds. `preparation-62.json` retains the intermediate native pass
before the failed-initial-page cases were added.

## Scoped screen review

| Review | Result |
| --- | --- |
| Actual components and tokens | Pass: reuses `BrowserPreviewSurface`, `BrowserFramePlaceholder`, existing status ring, buttons and `--gyro-*` styles. No CSS values or component variants added. |
| Empty, loading, error and recovered states | Pass in the isolated native frontend fixture. Cancelled copy is source/reducer checked; native cancellation state is separately exercised. |
| Truthful status and current error message | Pass through actual native failure, snapshot, hook and reducer. |
| Action hierarchy and status colors | Existing error-state controls and status styling retained. Try again is the recovery action. |
| Focus and keyboard | DOM focus passed; existing `--gyro-focus-ring` rule inspected. OS Tab/Enter, visible focus rendering and accessibility review remain unverified. |

## Limits

This is an isolated debug acceptance binary with production browser handlers,
embedded Tauri assets and native Apple WebKit. The full App/companion/split shell
was not mounted. Production CSP and private capture boundaries were retained;
the workspace sentinel stayed inaccessible through the asset protocol.

Actual post-commit network interruption, before-unload decisions, complex
redirect/superseded-start races, native OS input and full-shell acceptance remain
open. Post-commit failure restoration is covered by state tests, not a real
interrupted native response. The pass establishes no live-provider task success
rate or model-response speed. The earlier GPT/Grok benchmark remains
inconclusive. No installation, commit, push, release or deployment was performed.

`validation.json` records source hashes, final temporary roots, isolation and
remaining acceptance work. The working tree also contains unrelated changes.

Follow-up later on 2026-11-07: queued navigation cancellation was reproduced and fixed; screenshot recovery was visually verified through native UI automation after the Mac was unlocked. See [the dispatch and native review evidence](../2026-11-07-browser-navigation-dispatch/README.md). Full-shell and keyboard acceptance remain open.
