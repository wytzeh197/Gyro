# Browser instance ownership and benchmark fixture review

This pass fixes a browser replacement race and prepares a corrected GPT/Grok probe. It makes no new provider calls and does not establish a model ranking or a general response-speed improvement.

## Browser replacement

Native load/title handlers and tool result updates previously selected their destination by chat ID. Closing and reopening a browser in the same chat could let old work update the new browser's metadata, buffers, viewport, or screenshot reference.

The backend now captures the browser resource ID alongside the chat ID. It validates that pair before queued DOM evaluation, native mouse input, snapshot dispatch/encoding, and result commits. State updates check ownership while holding the state lock. Bridge nonce lookup captures the resource ID before processing console/network/title entries. Model tools stay bound to the first resource they observe until that tool returns; a subsequent tool can observe the replacement. Closed or replaced browsers cannot supply a new browser observation. Inspection and screenshots propagate status-read failures instead of converting cancellation into a successful fallback.

The existing Stop regression also remains active: cancellation releases a pending callback wait and suppresses its queued click. Already dispatched native effects cannot be undone. These changes do not guarantee atomicity with navigation within one resource or validate every frontend event already in transit. Frontend resource filtering remains separate work.

## Verification

- 20 focused browser tests passed, including stale state, console/network, viewport and pointer-capture rejection after replacement, and per-tool resource binding.
- 15 benchmark tests passed, including the six fixture-review cases and active-turn cancellation binding.
- The final debug build passed. Existing unused/dead-code warnings remain.
- The real WKWebView harness passed its 20-step fixture. It closes/reopens a browser, rejects the old model click, verifies zero clicks on the replacement, and rejects observations from both a closed resource and its replacement. The replacement then completes the normal read/find/click/form/screenshot/navigation/background checks.
- Browser capability, pointer feedback, observation budget, subagent isolation, navigation, viewport and provider manifest checks passed. The benchmark summary/resume checks and runner syntax check passed.

Native OS mouse and LSP suites were explicitly skipped. Accessibility permission was not probed. The raw smoke report now labels the mouse skip without inferring a permission failure. The runner also requires a successful process exit in addition to an `ok` report.

`browser-smoke.json`, `browser-replacement.json`, `browser-cancellation.json`, and `validation.json` contain the retained results. A single cancellation sample is not a percentile or provider-latency measurement.

## Corrected provider probe, prepared but not run

The prior [GPT/Grok probe](../2026-11-07-gpt-grok-live/README.md) found pending fixture edit proposals and a command-sandbox layout failure. Its original store and results remain unchanged.

The debug benchmark now accepts an explicit `reviewFixtureEdits` option, off by default. This reviewer only operates with a canonical temporary root containing separate `data` and `workspaces` directories. It accepts only an existing-file update owned by the exact active session and turn, restricted to README.md for README/follow-up tasks or src/clamp.mjs and clamp.test.mjs for code tasks. No-tool tasks approve nothing. It uses the existing core mutation decision API, retaining content-hash, path, symlink, session-root, atomic-write and cancellation checks. It stops when the run is cancelled, completes, disappears, changes turn, or reaches its deadline. Each turn permits at most 32 approval attempts. Audit entries contain IDs, paths and outcomes, without file content.

The offline integration test approves the two code fixture files, then runs the two clamp tests under the real macOS workspace command sandbox and verifies the task output. Separate tests leave wrong files/turns/sessions pending, preserve concurrent changes after a hash mismatch, reject symlinks, and reject legacy/aliased layouts.

The runner rejects resuming with a different review setting or enabling review in a legacy store. Native checkpoints also refuse mixed review modes. Summaries record `fixtureReviewMode`; these results must be assessed separately from unreviewed cohorts. `fullAccess` stays false and normal chat approval behavior is unchanged.

The [prepared spec](../benchmark-gpt-grok-reviewed-2026-11-07.json) selects GPT-6.1 Sol and Grok 4.7 at medium effort: one README task and one code task, each fresh and resumed, one trial. That is four measured attempts plus two bootstrap turns per provider, at most six new turns per provider. Cancellation is requested at 60 seconds per turn; cleanup can take longer. Native provider usage is not a hard dollar cap, and a turn may contain multiple model requests. This probe needs new usage authorization because the earlier capped batch has already used five GPT turns and six Grok turns.

Once authorized, start a fresh run:

```sh
node scripts/benchmark-providers.mjs --spec docs/performance/benchmark-gpt-grok-reviewed-2026-11-07.json --skip-build
```

A live run is still required to establish that provider adapters continue correctly after fixture review. The overall tool-use, speed and reliability goal remains active. No commit, push, release, deployment or installation was performed.
