# Companion first-reveal reliability

The previous native review recorded a blank companion and a 1% browser scale
until opening Inspector resized the window. That persistent failure did not
recur in this pass's pre-change review. Read-only diagnostics did confirm a
separate layout defect: the first animation targeted **0 → 0px** while its
parent rail had already reached 420px. The child layout effect had measured
before the shared portal's parent attached/revealed its rail.

`useCompanionMotion` now waits one animation frame to measure an initially
detached or zero-width dock. If it still cannot measure a useful width, it
settles without retaining a zero-width animation. Completion, external
cancellation and a deadline all release the native-browser motion gate. The
deadline is the configured animation duration plus 100ms (260ms with the
existing 160ms default). Cleanup cancels pending work and ignores queued
callbacks from an earlier render or unmounted panel.

The main window's existing appearance capability also grants
`core:window:allow-start-dragging`, which the native review previously reported
as denied. It remains restricted to `main`; embedded pages receive no added
capability. Current title-region gestures recorded no JavaScript rejection.
Actual window movement remains unverified: CUA's drag gesture did not change
the recorded native position. An out-of-window coordinate calibration attempt
was rejected by CUA and did not perform an interaction.

## Validation

- The actual production hook passes 14 deterministic layout/animation checks;
  10 fail against its prior implementation. These include missed completion,
  stalled frames, external cancellation, unmount, resize, reversal and reduced
  motion. Run `pnpm test:companion-motion`. The check is included in
  `test:reliability`; the full reliability suite was not run in this pass.
- Desktop TypeScript, existing browser host bounds/visibility checks, 10
  browser-draft checks and 21 browser event-routing checks pass. The guarded
  native build validates the capability identifier against Tauri's schema.
- Two native normal-App launches after the motion change opened the companion
  and browser without Inspector or viewport resizing. The final trace records
  an intermediate opening width with a **420px target**, then a settled 570px
  browser dock. The viewport stayed 1280×820 throughout.
- Native page input changed the fixture to `Clicks: 1`. Hiding and reopening
  the companion retained that state, with exactly one fixture document GET.
  The final trace recorded no JavaScript errors, including after child-webview
  creation; the diagnostics address the root webview directly in a multi-view
  window.
- All launches used the guarded review binary and its immutable store at
  `/private/tmp/gyro-shell-nLMuhJ/data`. Before/after `lsof` checks verified only
  that temporary database. The final audit has two synthetic conversations and
  zero rows in all five provider-turn/accounting tables. All review processes
  exited; the final executable hash remained unchanged. No paid provider call
  ran in this pass.

This is native macOS 26.2 evidence at backing scale 1. The earlier persistent
blank dock's exact triggering sequence remains unidentified. Lost-completion
recovery is verified by controlled checks of the production hook, not by a
native fault injection. Simultaneous split layout, native draft migration,
Retina/older WebKit and live GPT/Grok task/speed validation remain open.

## Evidence

- `motion-before.json`, `motion-after.json`, `motion-package.log`: hook checks.
- `baseline-companion-layout.jsonl`: pre-change zero-width target.
- `after-initial-layout.jsonl`, `final-companion-layout.jsonl`: corrected native
  motion, stable viewport, close/reopen and error observations.
- `after-first-open.png` / `.txt`, `final-after-reopen.png` / `.txt`: real App
  controls, native page, scale and retained click state.
- `*-manifest.json`, `*-isolation-*.json`, `store-audit.json`: lifecycle,
  immutable binary hash, fixture requests and database isolation.
- `validation.json`: source hashes, environment, assertions and explicit limits.

The diagnostics module is compiled only for debug builds with the explicit
`native-browser-shell-review` feature and an immutable, marker-guarded
temporary store. It observes layout, animations, errors and window bounds;
it performs no GUI actions. The production CSP, app identifier and installed
app were not changed by these review launches. The earlier isolation incident
remains documented separately in `../2026-11-07-browser-full-shell/`.
