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
