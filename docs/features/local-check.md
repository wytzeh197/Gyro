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

Before the scope change, eight core tests, four approval/completion tests, 15 existing sandbox regression tests, 13 browser UI assertions, desktop TypeScript and the native development matrix passed. After the scope change, 12 core tests (including real sandbox working/broken/broken-form/unavailable cases), four approval tests, 15 mocked-transport UI assertions, TypeScript and the rebuilt native binary passed. The new binary's working API case was observed in the native UI; the Mac locked during subsequent native cases, and Wytze chose to continue without native UI for now. Those cases remain deferred. Independent Computer Use observed the broken form while its API worked. These are separate evidence sources. The release candidate must repeat the applicable checks; this historical evidence does not satisfy release acceptance.

The architecture-size guard already fails at HEAD: `App.tsx` has 21,431 lines against a 20,329-line ceiling. Check adds three wiring lines; the feature implementation lives in separate modules. The existing unrelated token-efficiency changes were preserved. No dependencies or lockfiles were changed.

Comparison with a normal live agent workflow, real-user usefulness, AI cost measurements, installed/clean-machine acceptance and release readiness remain separate work. No paid or cloud integration is part of this prototype.
