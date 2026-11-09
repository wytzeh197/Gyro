# Editor preview memory retention — 8 November 2026

Opening successive clean Explorer previews left the replaced files in both the
workbench buffer map and Monaco's model registry. One visible tab could retain
hundreds of files. Explicitly closing the final tab released only that final file.
This is a separate memory fix following the [hardware/scheduling audit](../2026-11-08-hardware-resources/README.md).

## Measured reproduction

An isolated Chromium fixture uses the production workbench reducer and
`MonacoEditorPane`, with generated 1,024-line text files of approximately 130,000
characters each. It warms the editor, opens and closes a file, then visits 72
previews in three blocks. Every measurement forces garbage collection and reads
actual buffer/model counts and Chromium's used JavaScript heap. It does not hold
remote references to the models. No provider, native filesystem, user history or
preloaded text corpus participates.

Both development-server runs used Chrome/157.0.8103.39 through Brave, disposable
profiles, 1200 × 850 viewports and the same synthetic workload. Raw measurements:
[before](before.json), [after](after.json). The later fixture also supports multiple
split panes; the measured sequence still uses one pane throughout.

| Stage | Buffers before → after | Models before → after | JS heap before → after, MiB |
| --- | ---: | ---: | ---: |
| Warm empty | 0 → 0 | 0 → 0 | 22.00 → 22.16 |
| 24 previews | 24 → 1 | 24 → 1 | 28.10 → 25.39 |
| 48 previews | 48 → 1 | 48 → 1 | 31.60 → 25.52 |
| 72 previews | 72 → 1 | 72 → 1 | 35.08 → 25.64 |
| Close final preview | 71 → 0 | 71 → 0 | 34.25 → 24.51 |

After 72 previews, retained Monaco text fell from 9,347,024 to 129,962 characters.
The used JS heap was approximately 9.44 MiB lower at that point and 9.74 MiB lower
after closing the final tab. The decisive invariant is bounded buffer/model
ownership, rather than a particular heap percentage. Loaded editor modules and
other caches remain after closing; memory does not return to its warm-empty level.

**These are renderer JavaScript measurements, not native WebKit physical-footprint,
CPU, battery, latency or whole-app RAM savings.** The macOS app has not been rebuilt
or installed for this editor round. No claim is made about long-running chat
caches, many deliberately pinned files or hours-long sessions.

## Implementation and quality protections

- Replacing a clean preview removes its buffer only when no other editor group
  owns the file. Replacement is scoped to the active group, so another split
  keeps its tab and text. An obsolete selection is cleared on final retirement.
- Dirty, saving, errored and pinned files are retained. Actual unsaved buffer text
  protects the file even if its tab's dirty flag is stale. Background opens keep
  the visible preview.
- Monaco cleanup follows committed React ownership across buffers, tabs and
  panes. Tabs count before asynchronous reads complete. URI normalization treats
  equivalent local paths as one model; abandoned renders cannot retire models.
- A small event-driven retirement queue captures the old model instance and
  waits for adapters to detach. A rapid reopen cancels retirement. Shared/diff
  editor owners delay disposal until their model-change/dispose event; there is
  no repeating cleanup poll. Queue entries coalesce and release their listeners.
- Closing a tab without ever loading Monaco does not start Monaco for cleanup.
  Lightweight per-pane cursor/scroll mementos remain available when a closed
  preview is reopened. Pinned/shared files keep their models and undo history.
  Cursor/scroll metadata retains its existing pane lifetime; this change bounds
  text buffers and Monaco models, not every editor metadata cache.
- Explicit tab/group closes use the same committed lifecycle. Existing discard
  confirmations and save/recovery paths remain in place.

## Regression checks

`check-editor-resource-lifecycle.mjs` executes the actual reducer, hook and queue:
200 previews; dirty/saving/error/pinned/shared buffers; background opens; tabs
before reads; canonical paths; uncommitted renders; rapid reopen; captured model
identity; detach ordering; request coalescing; external disposal and listener cleanup.
It is included in `test:reliability` and the verification registry.

`check-editor-resource-browser.mjs` checks actual Monaco models after every block,
then verifies unsaved pinned text, undo after switching away and back, a shared
file in two split panes, last-owner close, closed-preview cursor/scroll restoration,
and 100 rapid preview requests during
lazy mounting. The [frozen run](frozen/after.json) builds the fixture first, avoiding
HMR during testing. Its heap numbers use a different bundling profile and are
correctness evidence, not the before/after comparison above.

Reproduce:

```sh
node --experimental-strip-types scripts/check-editor-resource-lifecycle.mjs
node scripts/run-workspace-navigation-browser.mjs --resources
# Or: pnpm test:editor-resource-browser
```

The browser check requires a locally installed Brave binary, or
`GYRO_CAPTURE_BROWSER` pointing to a compatible Chromium binary. Generated
artifacts default to `/private/tmp/gyro-editor-resource`; `GYRO_TEST_ARTIFACTS`
selects another output directory. The runner serves a disposable frozen fixture
on loopback port 1462 (`GYRO_FIXTURE_PORT` overrides it), and removes its temporary
bundle, server and browser profile afterward. `--baseline` records pre-fix counts
without bounded-resource assertions; it must be used with pre-fix production code.
Known Monaco Delayer cancellation rejections during editor disposal remain in the
JSON log. The guard accepts only the confirmed cancellation/disposal stack pattern
and fails on other renderer exceptions.

The checkout already contained unrelated changes. [Before source hashes](before-source.json)
identify the actual starting files; the Git HEAD alone is not the measured baseline.
[After source hashes](after-source.json) identify the final implementation and guards.
No user files, provider configuration or installed Gyro app were changed.

Validation completed: the lifecycle guard, development and frozen resource-browser
runs, TypeScript check, 14 language-session behaviors, editor recovery, code
intelligence, workbench viewport smoke checks, guard registry and scoped whitespace
check passed. The frozen build reports existing large-chunk/static-plus-dynamic
Monaco import warnings; no production bundling policy was changed.

The broader frozen workspace-navigation suite also passed: F12, Cmd-click,
references, independent split cursor/scroll, F2, keyboard rename preview/cancel/apply,
dirty and unopened-file transactions, undo, Save all, partial save failure and
recovery reload, including the 860 × 620 viewport. LSP/disk transports are mocked;
this does not establish native server/filesystem acceptance. Screenshots were
reviewed from `/private/tmp/gyro-editor-navigation-retention`.

Final resource-browser run passed after preserving closed-preview cursor/scroll
mementos. Its cold-mount probe yields between rapid requests so React can commit
intermediate previews, and waits for a fresh document after reload. New source
files pass Prettier. Temporary profiling app/data, browser profiles and loopback
servers created by this task were cleaned up; measurement JSON remains here.
