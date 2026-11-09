# Native compact menu bar — implementation review

Date: 2026-11-07. Scope: option 1, native approval-notification navigation, and Reply in chat.

**final result: passed**

This result covers the rendered production components and scoped source/native tests. It does not certify live-provider behavior, native macOS notification delivery, or an installed release.

## Visual targets and evidence

- Selected target: `../01-native-compact-refined.png` (1448 × 1086).
- Reply target: `../05-reply-in-chat.png` (1536 × 1024).
- Native notification concept: `../04-approval-notification.png`; actual notification appearance remains owned by macOS.
- Browser: `http://127.0.0.1:1420/menu-bar-fixture.html`. This fixture renders `MenuBarPopoverView`, the production component, using state derived from real event shapes.
- Browser viewport and screenshot: 1162 × 954 CSS/pixels, device pixel ratio 1.
- `browser-metrics.json` records every capture's actual card geometry, theme-independent layout, scroll bounds, and computed action colors/sizes.
- Cards are 372 CSS px wide. Full screenshots are retained. Comparison crops add the existing 16px side gutters and 8px/24px vertical gutters; source cards are proportionally resized to the same 372px content width. No OS chrome is part of the fidelity target.
- Full-view comparison: `design-comparison.png`, with source and implementation together for idle, working, approval, completion, and reply.
- Focused comparison: `reply-comparison.png`, enlarged equally for text, spacing, action, status, and footer inspection.
- User-facing screenshot sheet: `implementation-preview.png`. These are browser captures of working components, not Image Gen replacements.
- Light-theme evidence: `reply-light.jpg`. Production light tokens were checked; panel background computes to rgb(253,253,253).

## Findings and comparison history

1. Initial comparison: P2 — the reply block had unnecessary space. Reduced its footprint from 132px to 100px, preserving a keyboard-scrollable question area for long/multiple questions. Matching native geometry and regression tests were updated.
2. Initial comparison: P2 — native text and controls were visibly smaller than the selected concept. Used Gyro's existing 12/13/14/16px scale, 32px action height, a 44px header and 52px two-line task rows. CSS/native constants agree. `design-comparison-before.png` and `reply-comparison-before.png` retain the earlier comparison.
3. Functional review: P2 — merely selecting a chat could leave its previously dismissed question hidden. Menu navigation now refreshes the target chat and reveals its question. The real ChatSurface was exercised by dismissing and reopening its question; focus returns to the question form. Evidence: `question-reopened.jpg`.
4. Post-fix full-view and focused comparisons: no remaining actionable P0/P1/P2 differences in the selected scope. The idle card is 84px tall, working 188px, approval 260px, finished 136px, and reply 268px; transparent native gutters are additional.

## Required fidelity surfaces

- **Typography:** native Inter/system stack, 16px identity, 14px task/question/navigation text, 13px secondary/actions, 12px metadata. Semibold task hierarchy and tabular elapsed times; no rasterized interface text.
- **Spacing/layout:** original 372px width, 14px inset, 10px gap, 10px outer corner and 6px control corner. Settings shares the header. Idle has two rows. Waiting requests lead and other work becomes one summary row. Long questions and large request lists scroll while the header/footer remain reachable.
- **Colors/tokens:** scoped semantic menu tokens. Neutral idle, blue running, amber input/approval, green finished, red error. Primary background computes to rgb(228,170,82), matching the selected palette. Light and dark inspected.
- **Assets:** actual Gyro mark and existing Lucide icons, kept crisp. Concept desktop wallpaper and native OS chrome are not app assets and were not recreated in the app.
- **Copy/content:** task names and details come from the snapshot; status derives from actual jobs. Command text retains its full whitespace/content and can scroll. File changes open review instead of approving inline. Questions show their content and open the original chat; imported/superseded questions do not become live requests.

## Interactions checked

- Inline approval resolves and returns the task to running; failed approval remains visible and retryable; successful retry clears the error.
- Stop removes only the chosen running task.
- File review offers Review changes, with no inline Approve.
- Reply opens the original chat target by pointer and Return key.
- A dismissed question reopens in the production ChatSurface and receives focus.
- Settings and Open Gyro callbacks were exercised; the background-work summary uses the same Open Gyro callback in source.
- Keyboard focus is visible with a 2px ring. Long questions scroll with Page Down (observed scrollTop 42).
- Idle, working, approval, reply, completion, failure, file review, long question, many requests, loading, and unavailable states captured; dark/light checked.
- `browser-interactions.json`, `browser-metrics.json` and `browser-console.json` preserve the records. Final fresh-load console: no errors/warnings. One earlier fixture hot-reload root warning was resolved by preserving its development root.

## Validation and limits

- Desktop TypeScript: passed.
- Menu state checks: passed, including question clearing, streaming/imported history, pending/resolved approvals, complete command content, request priority, overflow and CSS/Rust geometry agreement.
- Existing chat-question checks: passed.
- Native menu tests: 7 passed. `native-tests.log`.
- Existing native notification tests: 8 passed, including preferences, permission state, private copy and actionable approval content.
- Scoped formatting and diff whitespace checks: passed.
- Production Vite build: passed in isolated `/tmp/gyro-menu-bar-verified-dist`; `production-build.log` and `built-geometry.json` verify the final CSS. A focused production component bundle and TypeScript check also passed after the final elapsed-timer dependency cleanup. The timer stays live while streaming snapshots change.
- Clean proposed-commit verification: desktop TypeScript, menu state, chat question and broad workbench smoke checks all pass with only this change applied to HEAD. `scoped-commit-checks.log` records the results. The full dirty worktree previously reported three separate assertions from unrelated work (run rail order, final-response/change-summary order, and plan-decision layout); `workbench-check.log` retains that earlier output. Those edits are excluded from this commit.
- Native tray clicks/window placement, live provider resumption, screen-reader operation, and actual macOS notification delivery were not exercised. Browser callbacks and Rust tests do not establish those native outcomes.
- No release, push, deployment, installation replacement or provider call was made.

## Follow-up polish

- P3: the background-work summary uses text and a chevron; the reply concept also included a blue dot. Its action and meaning are preserved.
- Native acceptance should include a real background approval, notification click from Settings, and a real answered question after rebuilding/relaunching the app.
