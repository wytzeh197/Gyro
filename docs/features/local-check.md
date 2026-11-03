# Local Gyro Check prototype

The verified command path checks one local web-app task with one explicitly reviewed command and one or two editable requirements. A structured native browser action is also implemented in source, with native acceptance still pending. Neither path uses AI, a hosted account, a paid provider, cloud sync or billing. Open a chat's **Chat options → Check this work** menu.

## What the prototype establishes

Each requirement has a stable observation key, expected JSON value and reviewed evidence scope: **API responses**, **Browser interaction** or **Other command assertions**. The approved test command must produce a matching observation, matching scope and supporting output. Gyro compares actual and expected values itself. Missing or mismatched scope remains Not checked independently for that requirement. An exit code, an AI claim or a missing observation cannot produce a pass.

These are assertions made by the reviewed test runner. They establish only what that runner actually tests. An incorrect or dishonest runner can give incorrect observations; the report is not an independent proof of arbitrary acceptance criteria. Raw output and the command remain inspectable.

| Controlled task                                                      | Add item    | Reject empty title |
| -------------------------------------------------------------------- | ----------- | ------------------ |
| Working fixture                                                      | Passed      | Passed             |
| Broken fixture                                                       | Passed      | Failed             |
| Broken form, browser-add requirement and API empty-title requirement | Not checked | Passed             |
| Unavailable server                                                   | Not checked | Not checked        |
| Denied or cancelled action                                           | Not checked | Not checked        |

The fixture is a small web app with an in-memory HTTP API. The broken implementation accepts whitespace-only titles. A second `broken-form` variant has a working API but a submit handler that adds nothing. The runner verifies API behavior, including returned items and collection sizes. It does **not** perform browser interactions, visual or accessibility checks. Loading Broken form proposes browser coverage for adding an item: its API-only runner therefore returns Not checked for that requirement, rather than converting successful API evidence into a browser pass. It cannot diagnose the form failure without a suitable browser assertion.

## Check window and background status

Check now separates Requirements, Review and Results. The review summarizes requirements, local URL, expected data changes and covered files; exact actions, expectations and snapshot details remain inspectable before approval.

After approval, closing the Check window leaves that check running in the current app session. A compact Gyro Check row above that chat's composer shows progress. Details reopens the same check without another execution; Stop requests cancellation separately. When execution settles, the row retains the result counts and can be dismissed. Stopped or missing evidence remains Not checked. This does not promise continuation after quitting the app.

## Command approval and execution

1. Edit the requirements, evidence scopes, expected observations, loopback test URL, command, expected data changes and relevant file list.
2. Review the backend's immutable plan, including its working directory and file hashes. Preparing a plan does not execute the test command.
3. Explicitly confirm the test environment and approve the exact action. Deny or cancel produces a local Not checked report without running it.
4. The backend consumes the plan once, checks its 10-minute expiry and revalidates the chat workspace identity and file snapshot. Changing a plan requires a new review.
5. The command runs once, for at most 60 seconds, through the existing process-group runner, credential scrubbing and macOS workspace filesystem sandbox. Failure never triggers an unrestricted retry or a switch to another tool.

This human-triggered review is distinct from the provider capability approval broker, whose authority is tied to a running provider turn. No provider/model tool has been added for approving Check plans. The prototype reuses the existing execution and confinement components; it does not claim that the existing browser/tool approval path already supports a durable Check transaction.

The filesystem policy allows network access and ordinary non-secret reads. A loopback URL does not make the target safe. Commands and their expected data changes require review. This is not full host isolation or a destination-filtering network sandbox. The Node fixture exposed a missing read-only `kern.hostname` allowance used by `uname` during `node:os` initialization; that narrow runtime allowance was added, without changing the write or network boundaries.

## Evidence contract

The command receives the exact approved URL in `GYRO_CHECK_URL`. It must exit zero and write one JSON object to stdout:

```json
{
  "version": 2,
  "previewUrl": "http://127.0.0.1:4317",
  "observations": [
    {
      "criterionId": "add-item",
      "scope": "api",
      "actual": true,
      "evidence": "POST /todos returned 201; GET /todos returned the created title and its id"
    }
  ]
}
```

Each observation must match a reviewed requirement key and its scope (`api`, `browser` or `command`). Duplicate or unknown keys, wrong URLs, invalid JSON, blank evidence, truncation and unsuccessful/interrupted execution remain Not checked. Missing keys, absent scope and mismatched scope remain Not checked independently. A valid matching-scope observation that differs from its reviewed expected value is Failed. Scope is a declaration made by the approved runner; an incorrect or dishonest runner can still misstate what it did.

Version-1 runner output cannot produce a current verdict. Earlier saved Passed/Failed results without matching reviewed and observed scopes become Not checked when read, retaining their raw output for inspection. They require a newly reviewed check; reading an old report does not execute anything. Historical acceptance artifacts retain their original data and are not rewritten by documentation updates.

Output is bounded to 32,768 stdout characters and 16,384 stderr characters, with additional byte/chunk limits. Reports contain the bounded raw output, process termination, timing, requirement mapping, expected and observed values, action, URL, working directory, session ID and snapshot. Use synthetic data and avoid printing secrets.

## Persistence and freshness

Reports are private local JSON files under Gyro's data directory in `check-reports/`, written atomically. The report view supports inspection and deletion. Development acceptance uses an isolated `GYRO_TEST_DATA_DIR`.

The snapshot fingerprints **only the 1–64 explicitly selected files** (at most 1 MiB each), the canonical workspace path and Git HEAD when available. Symlinks and traversal are rejected. The files must include the implementation and test runner relevant to the assertion. Files outside this selection and runtime/database state are not covered.

Changes during or after a check, unavailable files or changed workspace identity mark the report potentially stale. Freshness is checked after execution and every five seconds while the report dialog is open. Once observed stale, a report stays stale even if files are reverted. A new check needs new approval.

## Reproduce the controlled examples

In a chat rooted in this repository, open Check, expand **Controlled to-do example**, and load Working, Broken, Broken form or Unavailable. Review the plan and run it. The approved command starts its own isolated loopback server, creates synthetic in-memory items, captures the API responses, then stops its server. It fails if its port is occupied instead of attaching to an unknown app.

To inspect the web app manually:

```sh
node scripts/fixtures/gyro-check/server.mjs working
# Open http://127.0.0.1:4317; stop this server before running a Check fixture.
```

To create disposable data for native development acceptance (the project goes in ignored `target/local-check-fixtures/` build output so it remains visible in the normal sidebar):

```sh
cargo run -p gyro-core --example local_check_fixture -- /private/tmp/gyro-check-native-UNIQUE
# Launch a development build with GYRO_TEST_DATA_DIR=<printed data path>.
```

## Validation and remaining work

Focused verification commands:

```sh
cargo test -p gyro-core local_check --lib
cargo test -p gyro-desktop local_check::tests --lib
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit
node scripts/check-local-check-browser.mjs
```

The Rust integration case uses the real macOS sandbox and command runner against disposable working, broken and unavailable HTTP fixtures. It also verifies that a pre-cancelled action and files changed after review cannot execute a sentinel command. Unit cases cover parsing, missing evidence, failure/cancellation/timeout/truncation, snapshots, persistence, denied plans, expiry and single-use approval. The browser suite uses the production React dialog with **mocked transport**, and is not native or live-provider proof.

Before the scope change, eight core tests, four approval/completion tests, 15 existing sandbox regression tests, 13 browser UI assertions, desktop TypeScript and the native development matrix passed. After the scope change, 12 core tests (including real sandbox working/broken/broken-form/unavailable cases), four approval tests, 15 mocked-transport UI assertions, TypeScript and the rebuilt native binary passed. The new binary's working API case was observed in the native UI; the Mac locked during subsequent native cases, and Wytze chose to continue without native UI for now. Those cases remain deferred. Independent Computer Use observed the broken form while its API worked. These are separate evidence sources. See [the dated acceptance record](../reviews/local-check-prototype-2026-10-30.md) for exact versions, artifacts and remaining limits.

The architecture-size guard already fails at HEAD: `App.tsx` has 21,431 lines against a 20,329-line ceiling. Check adds three wiring lines; the feature implementation lives in separate modules. The existing unrelated token-efficiency changes were preserved. No dependencies or lockfiles were changed.

Comparison with a normal live agent workflow, real-user usefulness, AI cost measurements, installed/clean-machine acceptance and release readiness remain separate work. The [comparison protocol](../reviews/local-check-usefulness-protocol-2026-10-30.md) records the next experiment and leaves unperformed runs explicitly pending. No paid or cloud integration is part of this prototype. The separate private cloud service has an initial local simulator and API foundation; secrets, paid balances and entitlements must be enforced by that service independently of the open-source client.

## Subscription account entry

Product decision from Wytze, 2026-10-30; planned behavior for the optional cloud service:

- Opening and using the local app, local Check and user-owned providers requires no Gyro account. Do not create an account in the background or put a Gyro sign-in step in free onboarding. Provider authentication remains with the provider.
- Selecting **Subscribe** starts the account flow: **Create account or sign in → Checkout → Server-confirmed subscription access**. Creating an account alone grants no paid access. Existing signed-in customers can skip the account step.
- Existing subscribers have an optional **Sign in / Restore subscription** entry to recover access without purchasing again.
- Cancelling account setup or checkout returns to the usable local app. An expired login, cancelled subscription or unavailable cloud service must not block local work.
- Account creation does not opt the user into uploading projects, sessions or reports. Cloud data transfer still requires the appropriate explicit selection and consent.

Subscription acceptance must cover a fresh account-free launch, Subscribe with new and existing accounts, abandoned signup/checkout, restoring a subscription, cloud/auth failure, and continued local access after subscription cancellation. The private `gyro-cloud` browser simulator exercises this journey locally; hosted authentication, actual payment test mode and desktop subscription integration remain unimplemented. The local Check prototype creates no cloud account.

## Structured native browser action — awaiting native acceptance

Check can now prepare and review a native browser action instead of a command. **Check action → Native browser steps** accepts bounded JSON steps: fill one visible target, click one visible target, and observe selected visible text, text lists or counts. Each observation maps to one browser-scoped requirement and its approved expected JSON object. An expected-page selector is required, so an unavailable page cannot pass a zero-count assertion. Unknown operations, mixed browser/command plans, duplicate observations and mismatched keys/types are rejected before approval.

The browser action consumes the same single-use, expiring approval and revalidates the workspace/files before opening a separate hidden incognito browser resource. It reuses Gyro's native page-agent methods and protects credential fields. Navigation stays on the reviewed origin; downloads and new windows are denied. Pages can still make their own network requests. The action does not run a command or use the command filesystem sandbox. No failed command is retried through this path.

Actions are not retried after errors or uncertain acknowledgements. Only read assertions are polled for their reviewed interval (up to three seconds). Missing/ambiguous targets or missing page readiness remain Not checked; a completed mismatching DOM reading is Failed. A later unavailable step preserves earlier completed observations; accepted cancellation invalidates all verdicts. Browser diagnostics and observed values remain inspectable. The resource is requested closed on completion/error; native cleanup and isolation still require runtime acceptance. Page readiness has a ten-second deadline, followed by a sixty-second step deadline checked between bounded native calls; a call already in progress may finish later.

Browser results undergo privacy filtering before leaving the native transport. If that filtering changes assertion values, Check leaves the affected requirement Not checked. Redacted or shortened replacement text cannot create a pass or failure. A literal placeholder actually observed on the page remains valid evidence; metadata and ordinary browser tools keep their filtering. The [regression record](../reviews/local-check-prototype-2026-10-30/evidence-filtering-acceptance.md) distinguishes this tested code path from pending native execution.

For the controlled browser fixture, start a **fresh** server manually with `node scripts/fixtures/gyro-check/server.mjs working` (or `broken` / `broken-form`), then choose **Load browser form check**. The plan adds one visible item, submits a blank title, and compares visible item text/count and the error/count. Restart the fixture between checks. Unlike the API command example, this action does not start its own server. It checks DOM behavior, not visual appearance.

The new driver/evaluator has five state-machine tests in addition to the existing twelve core tests. These synthetic-driver tests are not native browser execution. The dialog has twenty mocked-transport browser assertions, including review of the ready selector/steps and denial without execution. Desktop types and Rust integration compile. Native execution of this new action, isolation from the chat browser, blocked navigation/downloads/windows, cancellation, cleanup, reports and restart persistence remain **unverified** while native UI testing is deferred at Wytze's request. See [browser action acceptance](../reviews/local-check-prototype-2026-10-30/browser-action-acceptance.md).

## Bounded height observations — 2026-10-31

Browser reads now also accept `kind: "height"`. This reads the unrounded `getBoundingClientRect().height` of exactly one visible, non-credential element in CSS pixels. The expected value must be a positive finite number no greater than 100,000. Missing, hidden, ambiguous, protected or invalid readings remain Not checked. A valid unequal height is Failed. This exact-value comparison has no implicit tolerance and does not prove general visual quality, occlusion, accessibility or responsive coverage.

Height reads require a reviewed `viewport: { "width": 1440, "height": 1080 }` on the browser plan. Allowed widths are 320–2560 and heights 320–1600. The dialog exposes these values; native creation requests those dimensions and the driver checks the actual CSS viewport before steps and again with observations. A mismatched/missing viewport is Not checked. Evidence retains both observed height and viewport. Existing saved text/count plans without viewport remain readable; new dialog plans include explicit dimensions.

The [next-slice acceptance record](../reviews/gyro-check-next-slice-2026-10-31/README.md) separates synthetic-driver, Chromium DOM and mocked-dialog evidence from pending native WebKit execution. It includes a prepared compact-row/stopped-wording draft for later human review; saving or validating that draft never approves or executes it.
