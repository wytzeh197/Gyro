# v0.1.2 local acceptance — 2026-11-10

This record distinguishes implementation checks from release acceptance. Local
checkout starts at `07dfacdbb93ba8be2c13df9bcca20ade70169ee9` on `Heads/v0.1.2`;
feature work is uncommitted alongside preserved concurrent changes.
The selected-source digests, observed HEAD, test counts and unsigned bundle hash
are recorded in `local-validation-manifest.json`; this is not a release attestation.

## Focused automated checks

| Scope | Result | Evidence log |
|---|---|---|
| Core memory | 27 passed | `/private/tmp/gyro-v012-memory-core.log` |
| Core reviews/fix intents | 10 passed | `/private/tmp/gyro-v012-reviews-core.log` |
| Core workflows/checkout leases | 10 passed; 1 subprocess helper ignored in the parent suite | `/private/tmp/gyro-v012-workflows-core.log` |
| Core automations, including legacy schedules | 20 passed | `/private/tmp/gyro-v012-automations-core.log` |
| Concurrent legacy-store migration | 1 passed | `/private/tmp/gyro-v012-migration-core.log` |
| Real loopback advisory HTTP transport | 4 passed; API and Ollama clean/forged-call cases | `/private/tmp/gyro-v012-advisory-transport.log` |
| CLI memory parity | 2 passed | `/private/tmp/gyro-v012-memory-cli.log` |
| Desktop memory | 7 passed | `/private/tmp/gyro-v012-memory-desktop.log` |
| Desktop workflows/extraction | 3 passed | `/private/tmp/gyro-v012-workflows-desktop.log` |
| Desktop review captures | 2 passed | `/private/tmp/gyro-v012-reviews-desktop.log` |
| Desktop workspace mutations | 5 passed | `/private/tmp/gyro-v012-workspace-mutations.log` |

The transport checks use a real local HTTP server and the production API and Ollama runners.
They refuse even assembling a tool catalog, inspect the actual outbound body,
verify only frozen input is sent, and return forged tool calls to verify refusal.
No credentials or paid-provider requests are used.

The focused suites total **91 passing tests**. The ignored checkout helper is
invoked explicitly by the passing multi-process lease test. Ordinary concurrent
chats are admitted, workflow/chat overlap is excluded across actual processes,
and process exit releases checkout ownership. They do not prove installed
CLI advisory support, live model quality, native process denial or real billing.

Desktop typechecking, architecture boundaries, semantic UI-token checks and
`git diff --check` pass. The unsigned debug bundle is built by
`pnpm --filter @gyro-dev/desktop exec tauri build --debug --bundles app --no-sign --ci`.
See `/private/tmp/gyro-v012-debug-build.log`. Product version stays at the existing
0.1.1 metadata; this is development source for v0.1.2, not a v0.1.2 release.

## Production-component browser fixtures

- Memory: `scripts/check-project-memory-browser.mjs`,
  `docs/screenshots/2026-11-10-v012-memory/manifest.json` — 9 captures.
- Reviews: `scripts/check-code-reviews-browser.mjs`,
  `docs/screenshots/2026-11-10-v012-reviews/manifest.json` — 11 captures including
  durable fix queue/cancel, implementing-turn link and Workspace/recorded-turn entries.
- Workflows: `scripts/check-workflows-browser.mjs`,
  `docs/screenshots/2026-11-10-v012-workflows/manifest.json` — 17 captures; the manifest is authoritative. Covers library/editor, explicit setup, stale adoption, queued
  launch/cancel, extraction/unproven source, conflicts, retry, requirements,
  visible keyboard focus and run deletion.

Browser entry points are also exposed as `pnpm test:project-memory:browser`,
`pnpm test:code-reviews:browser` and `pnpm test:workflows:browser`. Run an isolated
Vite fixture server on port 1432 (or set `GYRO_TEST_ORIGIN`) and use an installed
Chromium browser. The scripts are opt-in; they do not add browser/model
dependencies to default unit-test CI.

These are synthetic runtimes rendering production components. Native/provider
behavior is not inferred from them. Visual review corrected collapsed diff
height, checkbox sizing and a global list rule flattening ordered run evidence.
The run-deletion test caught an event-triggered refresh invalidating its own
mutation response; selection/lifetime guards now preserve the final navigation.

## Scoped native bundled-app smoke

Opened the unsigned debug bundle at
`target/debug/bundle/macos/Gyro.app`. Native accessibility and screenshot inspection
showed the bundled `tauri://localhost` WebView. Verified:

1. Automations → Workflows displayed the real authorized project/library.
2. New workflow rendered the real typed editor and ordered step controls.
3. Saving an empty recipe returned native `invalid workflow identity`.
4. Saved the temporary read-only `native-smoke-01a1c486` recipe. Native success
   returned to the library and displayed the saved project path.
5. Setup loaded native providers/tasks, kept provider/model unselected and Launch
   disabled. Check configuration returned `role implementer needs a provider and
   model`; no model was launched.
6. Verified the exact JSON on disk against the expected complete definition.
   SHA256: `47e6b076fac654080312d22a08e0224ac3282592f183c027f432575fbee69247`.
   Backed it up to `/private/tmp/gyro-v012-native-smoke/recipe.json`, removed only
   that temporary recipe, and native Refresh displayed the empty library again.

No provider/model selection, setup save, schedule creation or provider call was
made during the native smoke. Native output is recorded in this session's CUA
observations, not represented by the synthetic browser screenshots. No installed
application was replaced.

## Remaining acceptance

- Fresh/resumed real-provider memory and CLI/app continuity with a provider switch.
- A different provider reviewing a faulty change, selected fixes through the
  ordinary execution lane, and anchored re-review resolution.
- Actual sequential agent/review/governed verification workflow and extracted
  recipe with new inputs, including restart, tightened permissions and usage.
- Native Memory/review keyboard and accessibility, multiple windows/processes,
  active worker deletion/permission revocation, and representative usage receipts.
- Gyro-managed private worktree execution is currently disabled. Supported local
  checkout behavior must not be described as general managed-worktree support.
- Supported architectures, signed candidate upgrades, notarization/stapling and
  public release asset/download verification. Nothing is published or installed.


## Live local model probe — acceptance failed

The installed local Ollama `qwen3:0.6b` model was discovered before running one
explicit opt-in probe. The model list reported a local 522,653,767-byte model,
without remote-model/remote-host markers. No model was downloaded and no paid
provider was used. The production Ollama advisory runner received only synthetic
before/after arithmetic code (`a + b` changed to `a - b`) and a requirement that
`add(2, 1)` return 3. The host denied even assembling a tool catalog and imposed a
45-second cancellation deadline.

The call completed in approximately 8.5 seconds. The response wrapped its JSON in
Markdown fences and asserted that the test case was correct instead of reporting
the subtraction regression. The strict parser rejected it (`expected value at
line 1 column 1`). **Positive live review acceptance did not pass**; the parser
was not relaxed and the model was not silently replaced. This negative probe is
separate from the 91 passing automated checks and confirms a real local model's
output cannot automatically become a clean completed review.

Reproduction (requires that preinstalled local model):
`GYRO_LIVE_OLLAMA_MODEL=qwen3:0.6b cargo test --locked --offline -p gyro-core --lib live_local_review_probe -- --ignored --exact provider_runtime::advisory_transport_tests::live_local_review_probe`.

Log: `/private/tmp/gyro-v012-live-ollama-review.log`. The synthetic raw response is
preserved in `qwen3-0.6b-review-output.txt` beside this record. The probe remains
ignored by ordinary test runs because its result depends on an explicitly chosen
installed model. More capable live models and metered acceptance need an explicit
provider/model choice and spending limit.
