# Gyro frontend tester preflight — 2026-10-14

Current checkout: `/Users/wytze/Gyro`, `ca28b906` plus the preserved local changes. Node v26.0.0, pnpm 11.7.0. Browser tests ran hidden on cached Chromium headless shell 1243; the initial Workspace failure was also reproduced on installed Brave.

## Result

- `CI=true pnpm check`: PASS.
- `CI=true pnpm smoke:workbench`: PASS after repairing stale source expectations; the checked-in failure baseline remains empty.
- Independent complete reliability sweep: 98 invocations, 97 unique guard scripts, 97 passes and one failure (`check-architecture-boundaries`). `check-appearance-persistence` is intentionally invoked twice by the package script.
- `CI=true pnpm test`: FAIL only at the preserved architecture size gate. App.tsx has 20,338 lines against 20,329; lib.rs has 31,306 against 31,217. Root independently verified both exceedances already exist in HEAD. The aggregate test stops at App.tsx; the independent sweep prevents that from hiding later results.
- `CI=true pnpm -r test`: PASS: five Code Mode worker tests and both UI/desktop TypeScript suites.
- `pnpm test:efficiency-pilot`: PASS: all 40 independent baseline/reference-solution verifiers and report qualification gates, no provider calls.
- `pnpm test:cli-update-scope`: PASS.
- `git diff --check`: PASS.

## Real product blocker found and fixed

The Workspace edit bar could consume nearly the entire editor row. The base `:is(.gyro-workspace-route.is-code, .workspace-fixture) > .gyro-workspace-primary` selector had higher specificity than the edit-bar override, so the primary grid retained a single fractional row with an implicit second row.

Before: primary rows 776px / 37px; edit bar 776px; Monaco visible height 5px; Cmd-click timed out in both Chromium and Brave. A browser-only specificity correction yielded rows 33px / 780px and Monaco height 748px, and the same Cmd-click interaction passed. The product fix only scopes the override to the same base selector and adds `:has(> .gyro-workspace-edit-bar)`.

`packages/ui/src/workspace-rename.css` contains the selector fix. `scripts/check-workspace-navigation-browser.mjs` now asserts visible editor height and compact, nonoverlapping edit-bar geometry at initial mount and every return to main.ts. The complete Workspace renderer suite then passed, including compact 860×620 geometry (33px edit bar, 458px editor row, no overflow).

## Browser coverage

All ten named browser suites passed:

1. Chat dragging: quick/protected release, panes/sidebar, row/stack/grid, capacity, cancellation, draft preservation, maximize, foreign projects and narrow layouts.
2. Chat retries: countdown, cancel, keyboard/manual/automatic retry, simulated native wait/resume/cancel/completion/exhaustion, approvals, sign-in, themes/sizes and overflow.
3. Workspace: F12, Cmd-click, references, split cursor/scroll, F2, keyboard preview/cancel/apply, dirty and unopened files, atomic transaction, undo, Save all and recovery reload.
4. Syntax: four bundled grammars, multiline and embedded TypeScript/CSS/SCSS, offline edits, cold local assets, both themes at 1440/860, and WASM/grammar fault recovery.
5. Google models: actual production model picker, discovered-model selection, honest unknown context and absent effort control.
6. Canvas: interaction, revision, draft preservation/restore, responsive sizing, request handoff, parent/storage isolation and blocked network.
7. Media: actual chat components, six theme/size cases, repeated URL drops to the correct pane and retention of same-name image files.
8. History: all 3,100 initial events and 5,100 after growth, first message, upward reading during append/remount, explicit latest jump.
9. Motion: panel opening/closing, disclosure animation/reversal and reduced motion.
10. Efficiency: actual settings interactions and light/dark/narrow layouts.

Additional production-component browser checks passed eight theme/size/sidebar menu configurations with no overlap/overflow, New Chat callback, all six goal-run statuses with correct mark animation and editor-close accessibility, and fitted local browser iframe widths of 320/480/960. Screenshots of the light menu, goal strip, browser fit and fixed compact Workspace were visually reviewed.

## Test harness repairs

- Workbench smoke reads the extracted browser viewport component; keeps bounded compact menu spacing/grouping assertions; checks the actual leased-turn Plan-mode guard; executes the goal working-state expression across all active/running/status combinations. No failure baseline changes.
- Embedded surface guard executes the actual boot appearance/storage helpers with native operations forbidden, instead of rejecting their valid new imports.
- Composer context guard reflects retired Gemini and unknown Antigravity defaults; explicitly prevents an invented retired-provider allocation.
- Verification map classifies the three already-running Google/model-context guards as behavioral.
- Root separately repaired page reliability to execute the actual appearance/storage helpers.

## Limits

Browser fixtures use real production components, but Workspace LSP/disk transport, history data, provider sends and media storage are explicitly mocked. Finder gestures, WKWebView/AppKit, installed-package startup, native event transport and live-provider acceptance require the root/native portions of preflight. No remote write, external message, release or publication was performed here. All unrelated dirty/untracked files were preserved; temporary fixture builds did not modify apps/desktop/dist. The dedicated Vite fixture server was stopped after tests.

Logs, results JSON and screenshots are saved under this frontend directory. Syntax fault screenshots also follow the existing runner's fixed `/private/tmp/gyro-workspace-syntax-browser/retry-*` paths.
