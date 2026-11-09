# Native split-browser visibility

The real normal-App drag flow reproduced a bug: opening Beta's companion hid
Alpha's browser behind “Preview hidden”, despite the two panes occupying
separate columns. The App explicitly treated `!isFocused` as browser occlusion
and replaced the unfocused pane's native bounds with `null`.

The pane now passes global overlay state and its own host bounds independently
of keyboard focus. Existing browser-host observation still hides an unmounted,
hidden or covered host, and global dialogs still occlude native pages. Browser
ownership and per-chat native queues are unchanged.

## Evidence

- `native-before.png` / `.txt` show Alpha hidden beside Beta's live page.
- `native-after.png` / `.txt` show both real WKWebViews at once: Original in
  Alpha and Second in Beta, each with independently changed page state.
- The split was created by dragging the real Beta sidebar row beside Alpha,
  without scripting application state or replacing the App entrypoint.
- A global Search dialog hid both native pages (`global-overlay.txt`); Escape
  restored both, with page state retained. There was exactly one document GET
  per page in `after-manifest.json`.
- Capturing Beta created one prepared attachment in Beta and none in Alpha.
  `store-audit.json` verifies 1280×800 dimensions and equality of every RGBA
  pixel with the original browser capture.
- Closing Beta's Browser tab left Alpha's Original page at `Clicks: 2`
  (`after-beta-close.txt`). The final layout diagnostics recorded no JavaScript
  errors. Both review processes exited after their audits.
- Four checks execute the actual pane JSX props and native-bounds callback;
  all pass, while two fail against the prior App. Run
  `pnpm test:browser-pane-visibility`. It is included in `test:reliability`.
- Desktop TypeScript, existing host bounds/visibility, browser-draft, pointer
  drag and grid-state checks passed. The full reliability suite was not run.

The runner's new `--visible-workspace` option creates a marked, disposable
Git project under this evidence folder. This exercises the real sidebar
without changing the production rule hiding temporary workspaces. The seeding
binary requires a canonical workspace and a marker matching its compile-time
temporary store, and verifies stored sessions actually belong to that
workspace. Positive reseeding and rejection of a wrong workspace marker are
recorded in `workspace-guard.json`.

All native runs used the guarded review binary, unique app identity, normal
CSP and isolated `/private/tmp/gyro-shell-WZRuqH/data` store. Before/after open
file audits verified its database boundary. All five provider-turn/accounting
tables remain empty. No paid provider calls ran.

## Scope and remaining acceptance

This proves two-column visibility, page input, screenshot ownership, global
Search hide/restore and closing a browser tab on macOS 26.2 at backing scale 1.
No visual tokens or component styles changed. The native loading and populated
states were observed; other network errors are outside this pass. The existing
narrow-pane overlay intentionally covers that pane's transcript and retains
its existing controls.

Native child-view clicks and active-chat keyboard shortcut routing still need
focused acceptance, as do maximized/hidden panes, other split arrangements,
native draft migration, Retina and older WebKit. Live GPT/Grok task success
and speed validation still await additional authorized provider usage. The
overall goal remains active.
