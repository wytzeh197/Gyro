# Chat layout hardening — 2026-09-22

The supplied screenshots showed one conversation duplicated across split panes,
an existing conversation alongside an unlabelled welcome pane, and unstable
layout after closing a pane. The embedded conversation text is reproduction
content, not a request to run a separate reliability/security upgrade.

## Guarantees enforced by this change

- Draft creation and persisted session-ID handoff keep one pane per conversation,
  retaining the focused pane when two identities converge.
- A removed or replaced maximized pane cannot hide the remaining layout.
- Closing or removing a pane expands a lone survivor and clears obsolete split
  settings. Restoring a sparse single-pane layout also repairs its placement.
- Delayed close confirmations resolve the original pane and session. They cannot
  switch the user back to a background project or close a replacement session.
- Clicking or keyboard-focusing another pane's close button does not select that
  conversation first.
- A tiled draft has its own title, close button, visible drag handle, and bounded
  scrolling area. Full-window welcome sizing does not spill across a row split.
  Short panes omit welcome artwork and starter shortcuts to keep the composer
  visible; those return when the pane has room.
- Split transcripts reserve the measured composer height with a compact gap,
  instead of wasting short panes on full-window bottom spacing.
- Two chats side by side offer only the two edges and the seam between them:
  dragging a third chat there keeps one row of equal columns (three, then four
  across, which is `CHAT_GRID_MAX_SLOTS`), never a 2×2 quadrant. A full row
  offers boundaries when rearranging a chat already in it, but no target for a
  new chat. Stacked chats offer top, bottom and horizontal seam targets that
  preserve their stacked arrangement. A 2×2 grid keeps quadrant targets.

## Regression coverage

`scripts/check-chat-pane-close.mjs` covers identity convergence, retained focus,
stale maximize state, background closes, closed-pane reopening, restore and
removal. `scripts/check-chat-close-target.mjs` exercises the same close-target
resolver used by the desktop app. Both run in `pnpm test:reliability`.

For visual and interaction checks, run the desktop Vite preview and open
`/chat-layout-hardening.html`. The development-only fixture uses the production
grid, chat surface and reducer with inert sample sessions. Its controls cover:

1. Running chat with a draft to the right or below; verify separate pane headers,
   accessible close controls, contained composers, and independent scrolling.
2. Type in a draft and close the other pane; verify its text and focus survive.
3. Restore duplicate stored chats; verify exactly one full-size conversation.
4. Add a distinct running chat and enable long transcripts; scroll each pane and
   verify Stop stays with its own conversation.
5. Exercise narrow widths and short heights; draft content may scroll, while its
   header and close control remain reachable.
6. With two chats side by side, press _Simulate chat drag_ then _Drop simulated
   chat_: three full-height bars mark the two edges and the seam, the bar under
   the pointer lights up, and the dropped chat lands between the two. Three
   chats side by side then offer four bars; four across offer five bars only
   when rearranging one of those chats.

The fixture does not call providers, stop real tasks, or modify saved chats. It
does not replace a native packaged-app check before release.

## Verification in this round

- Desktop and shared UI TypeScript checks passed.
- Pane identity/close tests, workbench smoke checks, UI tokens, chat hardening,
  chat-run, companion and side-panel checks passed.
- Browser: checked stacked running/draft panes at 1280×720, draft preservation
  after closing its sibling, duplicate restore to one pane, two distinct running
  chats in a 620px-wide fixture, independent transcript scrolling, isolated Stop
  actions, and a contained environment popover. Inspected screenshots and DOM
  bounds; both narrow composers fit inside their panes.
- Native Gyro was not rebuilt or installed during this round.

## Splitview drag hardening — 2026-10-11

Sidebar rows and pane titles now use the same drag lifecycle and placement
semantics. Toolbar and close controls remain separate from the title source.
Drop targets show their placement highlights without visible text; the hidden
live announcement remains available during a drag.

- Protected WebKit data stores retain both session and pane identity. Renderer
  tokens reject delayed native events without cancelling a newer drag.
- Escape, blur, page hiding, outside drops and removal of a source clear drag
  feedback. External text and file drags invalidate stranded chat state and
  retain their own input/attachment behavior.
- Fast releases before React paints use the same geometry and tie rules as the
  rendered preview. Invalid coordinates, hidden targets and stale overlays
  cannot pick a different destination. A stationary pointer follows layout
  changes and resizing.
- Rows and stacks insert at their visible boundaries; quadrants swap existing
  panes or safely displace an occupant while capacity remains. Full layouts
  reject new chats. No drop evicts an open conversation.
- Drops at the source or either adjacent boundary preserve focus, drafts and
  maximization. Accepted moves keep original pane IDs and reveal the split.
- Cross-project drops validate the session's real project, then focus its
  existing pane or append into available space in its own layout. They never
  reuse an unrelated project's slot or arrangement.
- Grid dispatch resolves acceptance against pending state before changing the
  active session or refreshing its events. Two drops queued before rendering
  cannot select a chat that the second layout update rejected.

The reliability command includes payload/lifecycle checks, 87,300 geometry
comparisons, exhaustive sparse/quadrant/row/stack reducer cases, and tests that
execute the real desktop callback and dispatch wrapper through its TypeScript
AST. Run `pnpm test:chat-drag-browser` for the isolated production-component
fixture at `/chat-drag-preview.html`; it checks drafts, capacity, cancellation,
maximization, project switching and narrow layouts in a headless browser.

Verified in this pass: shared UI and desktop TypeScript checks, the complete
isolated browser suite (including real mouse-start payloads and one-composer
image routing), payload/lifecycle, geometry, reducer, desktop callback,
persistence, pane-close, new-session, close-target and media-transfer checks.
Inspected stacked and narrow-row screenshots. The broader workbench smoke still
fails its pre-existing Environment popover assertion; its drag checks pass.
Headless macOS Chromium may cancel the custom-data-only OS handoff, so mouse
checks verify source payloads/cancellation while synthetic browser events cover
the complete protected drop path.

### Native macOS acceptance

The native follow-up built two disposable, ad hoc signed Tauri applications:
the production-component fixture and the actual desktop `main.tsx`/`App.tsx`
with seeded local chats. Both embed the current frontend and retain the normal
macOS window settings, including `dragDropEnabled: false`. The actual app uses
a debug build, a separate bundle identifier, temporary native data, and an
ignored disposable workspace. No provider turns were run and the installed
application was not replaced.

The native review found that placement feedback could cover its own pane-title
drag source. WebKit rechecks that source after `dragstart`, so the overlay and
its children now use `pointer-events: none`; the grid capture handlers retain
placement hit-testing. The browser suite verifies this computed style and still
passes its complete drop scenarios.

Build the fixture with `node scripts/build-chat-drag-native.mjs`, or the actual
application with `node scripts/build-chat-drag-main-native.mjs`. Each command
prints a manifest containing its disposable `.app` path; neither launches or
installs it. Packaging selects Cargo's reported executable and requires enabled
debug assertions, so output-directory overrides cannot select a stale binary
or disable the native test-data isolation guard. Open that bundle and operate
it through CUA or manual native input.
The fixture writes `state.json` with trusted event, payload and layout snapshots.
The full app exercises its normal commands and drop callbacks with Alpha through
Epsilon, each containing a distinct unsent draft.

Native input automation emitted trusted `dragstart` events and the correct
custom MIME payload, but no target `dragenter`, `dragover` or `drop` events.
Manual input was therefore used to verify actual gesture delivery: dragging
Beta from the fixture sidebar to the right of Alpha produced two panes, as
confirmed by the user. The full native app also displayed Alpha and Beta with
both seeded drafts intact after opening Beta through the normal chat-grid menu.
The user also confirmed all three final checks in the updated full native app:
dragging Alpha's title to the far right reordered it behind Beta while both
drafts survived; Escape left the order unchanged and cleared feedback; adding
Gamma and Delta made a four-pane row, and dropping Epsilon refused the fifth
chat without losing any open pane. These are manual native acceptance results,
separate from the passing browser suite. The Mac locked before an independent
final accessibility/screenshot capture.

The diagnostic `native-automation-public-transport.json` under
`docs/reviews/native-chat-drag-2026-10-11/` records an unsuccessful automated
drag with a temporary public-text diagnostic. That diagnostic was removed from
the source and did not change event delivery. Its event flags were recorded
before application handlers; the current fixture separately labels values
before and after handlers. The file is automation-limit evidence, not a manual
drop acceptance record.

The subsequent visible-label removal keeps the same empty tile elements,
positions and highlights. Its UI typecheck passed. The browser rerun stalled in
host filesystem reads of dependencies/assets and required termination before
scenario execution. This final cosmetic change was checked in the production
render path; the native and browser acceptance results above predate removal
of the visible labels.

### Production installation — 2026-10-12

Rebuilt the `v0.1.0` working tree at `2b27feb` with its local changes and
installed the resulting release bundle in both `/Applications/Gyro.app` and
`~/Applications/Gyro.app`. The production assets were checked for drop tiles
with no text children and the overlay pointer rules; the executable contains
the corresponding asset names. Both installed copies match the signed build
and pass strict signature verification. Previous bundles were retained under
`/private/tmp/gyro-reinstall-fb0ef00d-42ab-4768-b130-2fba7d1109a7/`.
Reopened the native application and verified that its workspace loaded with
`v0.1.0` selected. The frontend build completed with the installed Node 22
runtime after the Node 24 build processes stalled in dependency reads.

### Recording regression and pointer transport — 2026-10-12

Reviewed all 1,106 frames of the supplied 19.297-second recording. Both gestures
start on the unopened Narrow Chat Layout sidebar chat and release over the
Environment popover's Processes row. The left preview begins at frame 213
(3.733s) and frame 583 (10.200s), changes to the right at frame 299 (5.233s)
and frame 671 (11.717s), then disappears at frame 357 (6.250s) and frame 717
(12.517s). The native green plus disappears at frame 355 (6.217s) and frame 716
(12.500s). Neither attempt creates a second pane. The conversation shown in
that recording is evidence, not an instruction to implement its motion request.

Internal sidebar and pane-title drags now use a six-pixel pointer threshold,
pointer capture, and the existing placement geometry and drop reducer. Their
identity stays in the renderer throughout the gesture. Releases use current
grid geometry and the painted element under the pointer, so Environment
children can accept a split while an unrelated covering modal cannot. Native
file drops retain their existing attachment path. A completed or cancelled
chat gesture suppresses its follow-up click and clears source feedback,
capture, listeners, cursor state, and placement feedback.

Real mouse tests caught two transport failures before acceptance: capturing
an element's focus blur cancelled the pending gesture, and macOS WebKit
reported zero pressed buttons during a held mouse gesture. Only a true window
blur now cancels the gesture; observed pointer release/cancellation owns its
lifecycle. The unit suite covers both cases, removal, hidden targets, stale
native events, fast releases, and cleanup. It runs in test:reliability.

Validation passed: desktop and shared UI TypeScript, pointer/native payload
lifecycle, 87,300 placement-geometry comparisons, exhaustive reducer placement,
the real desktop callback/dispatch, pane identity/close, and media-transfer
checks. The complete isolated browser suite now performs real mouse drops
onto Environment > Processes, reorders pane titles, preserves typed drafts,
rejects full layouts and covering modals, and checks outside/Escape cancellation.

Native macOS acceptance used a disposable, ad hoc signed Tauri fixture with
the current production components, normal window options, and CSP. A temporary
standalone Cargo package avoided unrelated concurrent desktop-library edits.
Trusted native mouse input opened Beta to the right of Alpha by releasing over
Processes, then moved Alpha to the far right while its typed draft survived.
The recorded final order is Beta, Alpha, with no native drag handoffs and all
feedback cleared. These are native production-component fixture results; the
installed production application has not been updated with this source change.
Evidence is in docs/reviews/chat-drag-recording-2026-10-12/.
