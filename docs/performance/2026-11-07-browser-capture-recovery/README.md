# Screenshot preview recovery

The production capture view now shows a recoverable error when a screenshot file cannot be decoded. “Take new screenshot” requests a fresh capture; feedback remains disabled until the replacement image has decoded. Changing the image source or capture identity resets image readiness and the feedback draft. An error from a detached old image cannot change the replacement view.

The change is in `packages/ui/src/browser-capture-view.tsx` and `browser-capture.css`. It reuses Gyro's browser placeholder, loading indicator, action styles and semantic disabled token. Capture creation and image decoding remain separate states: an existing capture record does not prove that its image is readable.

## Evidence

- **Negative control:** the unchanged capture component reached a real missing-asset decode failure, then failed with `failed screenshot did not expose an unavailable state`. [baseline.json](baseline.json) retains its 16 completed checks and actual native image dimensions of zero.
- **Native regression:** [native.json](native.json) passes all **41 checks** in embedded macOS WebKit with the production browser component, hooks, reducer, queue and Tauri handlers. A deliberately unavailable asset record fails to decode, renders the accessible error, blocks feedback, offers a retry, and is replaced by a newly captured native PNG. The replacement re-enables feedback and ignores a detached old image's error event. Native command responses are unmodified.
- **Visual review:** the production capture component was inspected in the in-app browser's layout fixture. The unavailable message and disabled feedback control were visible. Clicking the retry replaced the missing source with the fixture's SVG image and enabled feedback. This visual fixture uses a simulated native host; the separate native regression verifies actual capture and asset decoding.
- **Regression/build checks:** both desktop and UI TypeScript checks, the normal desktop Vite build, 16 event-routing cases, browser pointer/capability/reveal/viewport/navigation/session-isolation/host checks, architecture boundaries and scoped whitespace checks pass. Logs and source hashes are retained here. The normal build excludes the native acceptance entry and its script markers across 104 emitted JavaScript files.

The native test retained the earlier close/reopen checks. Close completed in **3 ms** while an old native read result was held. That is one local sample, not a percentile or a measurement of model response time. There were no script errors or CSP violations; capture assets were allowed and the workspace sentinel remained denied.

The isolated native store has zero provider bindings, turn messages, turn statuses, usage links and efficiency task turns. No additional live model turn was dispatched. The earlier GPT/Grok probe did not establish task completion or support a model ranking; its reviewed rerun still needs additional usage authorization.

## Scoped screen review

| Check | Result and evidence |
|---|---|
| Existing components/tokens | Pass in source: browser placeholder/action/loading classes and `--gyro-status-disabled` reused. |
| Error/populated states | Pass in native regression and browser visual fixture: unavailable asset, retry and decoded replacement. |
| Loading state | Implemented from actual image load state; slow-loading appearance not separately held for visual review. |
| Truthful status | Pass in native regression: feedback depends on decode readiness, not just capture-record existence. |
| Action hierarchy | Pass in browser visual fixture: one recovery action in the error body; existing Back to live/Reveal file controls retained. |
| Stale source/draft handling | Source identity remounts the capture view; native regression rejects the old image's error. A populated draft's source-change flow is not independently exercised here. |
| Keyboard/focus | Existing native fixture checks DOM address focus and Escape. Recovery-button keyboard navigation, OS input and macOS Accessibility remain unverified. |
| Whole-shell layout | Unverified: native fixture mounts the production browser surface, not the full App/companion/split controller. |

Native desktop visual inspection was unavailable because the computer-use service reported that the Mac was locked. No attempt was made to unlock it. The browser fixture review does not substitute for native OS input or whole-shell acceptance.

## Preparation and remaining work

Two preparation failures are retained under `preparation/`: one native fixture timeout without a conclusive cause, and one compilation failure from using a private Tauri enum path. The fixture now uses the public enum path and disables background throttling only for its dedicated debug window. Neither preparation failure is counted as product acceptance.

[validation.json](validation.json) records the native run, baseline hashes, current source hashes, clean provider counters and verification limits. Full-shell and OS-input acceptance, same-resource loading/ready ordering, and live GPT/Grok task completion remain open. No install, commit, push, release or deployment was performed.

Follow-up later on 2026-11-07: queued navigation cancellation was reproduced and fixed; screenshot recovery was visually verified through native UI automation after the Mac was unlocked. See [the dispatch and native review evidence](../2026-11-07-browser-navigation-dispatch/README.md). Full-shell and keyboard acceptance remain open.
