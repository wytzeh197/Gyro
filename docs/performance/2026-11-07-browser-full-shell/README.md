# Browser before the first message — native App acceptance

Started 2026-11-07; completed this pass on 2026-11-08. The normal App startup,
Workspace browser drawer and draft composer now complete a real native
open → interact → Mobile → capture → attach flow before any model message.
The companion and multi-chat split flows remain separate acceptance work.

## Reproduced failures and fixes

The frontend uses `workbench` or `workbench:<workspace>` before a durable chat
exists. The backend's subagent-ownership check required a UUID for every open.
In the actual App, a valid local URL failed with “invalid length: found 50.”
The page panel then described the failure as an unreachable server. The saved
native baseline is `draft-native-failure.png` and `.txt`.

The desktop IPC command now accepts validated workbench owners. Model tool
opens retain the existing durable-chat check and private subagent behavior.
Workbench native labels hash the complete key: spaces and punctuation in a
workspace path no longer invalidate a label, and stripping hyphens cannot merge
two workbench paths. Existing chat and private Check label behavior is retained.

Two frontend problems were also reproduced by executing the actual App
callbacks. Folderless draft navigation returned before calling native open.
Draft captures passed a workbench key to the UUID-or-`new` attachment API,
swallowed its error and never attached the image. The first guard is removed;
pre-chat captures now use the existing `new` namespace while keeping their
draft key. Empty browser-preview actions also stop submitting an empty address.
No product CSS, design tokens or visual variants changed.

## Native verification

The review embeds the ordinary Vite App assets and runs normal backend startup.
It does not take the early-return browser-fixture setup path. Native controls
opened a disposable project in Restricted Mode; no trust, provider connection,
CLI update or OS notification permission was granted.

Observed through native accessibility and screenshots:

- The project draft's preview opened and displayed “Shell Original ready.”
- Activating “Change visible state” produced “State: changed” and “Clicks: 1.”
- Selecting Mobile changed the reported viewport to 390 × 844 and the page to
  its compact layout.
- A native screenshot decoded in the App's capture view at 390 × 844.
- Returning to Sessions showed that PNG in the unsent draft's Attachments.

The original capture and prepared draft image were independently decoded. Both
are 390 × 844 and their pixels are identical. See
`native-draft-image-comparison.json`, `native-store-audit.json`, and the copied
`capture-browser-preview-*.png`. Manual observations are recorded separately
from automated test verdicts in `manual-native-review.json`.

![Native mobile capture in the normal App](/Users/wytze/Gyro/docs/performance/2026-11-07-browser-full-shell/native-mobile-capture.png)

| Automated validation                                               | Result                             | Evidence                                                      |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| Actual App draft callbacks                                         | 4 passed; 3 failed before repair   | `draft-baseline.json`, `draft-after.json`                     |
| Rust browser tests, including owner/label and subagent regressions | 59 passed                          | `browser-tests.log`, `browser-tests-manifest.json`            |
| Ten browser regression scripts                                     | Passed after headless-launch retry | `browser-regressions.json`, `browser-agent-runtime-retry.log` |
| Desktop TypeScript                                                 | Passed                             | `typecheck-final.log`                                         |
| Native review executable                                           | Built; unchanged during final run  | `native-after-manifest.json`                                  |
| Isolated final store provider tables                               | All five inspected tables empty    | `native-store-audit.json`                                     |

The headless DOM check initially could not launch its browser inside the
sandbox. It passed with permission to start its disposable browser and loopback
debug socket. The first native fixture path also exceeded macOS's Unix socket
path limit. The replacement uses a short `/private/tmp/gyro-shell-*` root.

## Isolation failure and repair

The first review launcher ran the normal binary with a temporary-store
environment variable. Its 30-minute process expired while native control was
delayed. Native control then relaunched that temporary bundle without the
environment; process 53611 opened the normal
`~/Library/Application Support/Gyro/gyro.sqlite3`. That process was stopped and
its temporary executable made non-executable. No UI edit or intentional model
request was made in that relaunched process. Normal startup can run recovery
and background routines; without a prior database snapshot, this pass cannot
prove that the normal store was unchanged. No speculative rollback was made.
See `isolation-incident.json` and `first-launch-manifest.json`.

The replacement review-only binary pins its temporary data path at compile
time before calling any normal helper or App startup. It refuses release-mode
startup, a missing/invalid marker, an unexpected path or a symlinked data path.
It clears inherited Gyro test flags, sets the pinned store and uses an incognito
root webview. Each review root also has its own app identity. A native relaunch
without the runner's environment was inspected with `lsof`: it held only the
temporary database/socket. Removing the marker made a separate launch exit 2
before app startup. See `isolation-negative-control.json` and
`native-isolation-open-files.json`. The final isolated store has zero provider
bindings, messages, statuses, usage links and efficiency turns. Its app and
fixture servers were stopped after review.

## Review and limits

The existing AppShell, BrowserPreviewSurface and ChatSurface were used with
their real `--gyro-*` styles. Empty, loading, failed, live, Mobile and captured
states were observed. The composer showed the actual captured file, and Send
remained disabled with no provider connected. URL/search input and native
buttons worked; complete Tab/focus traversal was not verified. Earlier control
and accessibility delays after relaunch were not diagnosed as a product bug;
the native inspector later recorded tour dismissal and controls worked. No
tour or dialog code was changed. An inspector error also showed an unhandled
notification permission-probe rejection; that remains follow-up work.

This is a local debug App on macOS 26.2 at backing scale 1, not an installed
release. Native folderless navigation, project paths with spaces, complete
companion/split behavior, Retina/window transitions and older WebKit still need
acceptance. Folderless and path-label behavior currently has callback/Rust
coverage. The private WebKit inset API limitation from the geometry pass remains.
No live model quality, first-token speed or task-success claim follows from
these browser checks. Further paid GPT/Grok work awaits its requested budget.
The broader goal stays active.

To reproduce, run `node scripts/run-browser-shell-review.mjs` and use native
controls on the reported temporary app and project. It records lifecycle,
not a UI pass. After stopping that app, `--reuse <reported-root>` rebuilds the
same guarded review bundle/store for iteration. All model actions remain manual
and this review workflow does not authorize provider turns. Automated checks
use `node scripts/check-browser-draft.mjs`; Rust test invocations must set an
explicit temporary `GYRO_TEST_DATA_DIR` as recorded in their manifest.
