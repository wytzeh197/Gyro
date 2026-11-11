# Composer reference implementation — 2026-11-11

Implemented Wytze's supplied composer reference in the production component.
New chats place the composer at the bottom, with the project/folder, workspace
mode and branch controls above the input on the left. The input has its own
rounded surface; Add, approval, context usage, model, effort, dictation and Send
remain in a separate toolbar below it. The welcome heading occupies the free
space above. Existing provider/model/session handlers are retained.

## Review

- **Tokens and components — pass.** Existing Gyro surface, border, radius,
  typography and scaled spacing tokens; existing production controls. Chat CSS
  stays in `packages/ui/src/chat.css` and remains within its rule budget.
- **Empty and unavailable — pass in browser fixtures.** Connected and
  disconnected providers, both themes, three interface sizes and two viewport
  widths. Setup copy replaces the placeholder; clicking it permits drafting.
  Connect opens the real Settings UI; Send stays disabled without a provider.
- **Populated and running — pass in browser fixtures.** Existing thread,
  streaming, code and split scenes render the new input/toolbar arrangement.
  A pointer/keyboard probe typed ten lines at 1440px and 900px; the composer
  remained 18px from the bottom, Add stayed within the pane, Branch opened,
  Escape closed menus and a fixture send transitioned to the thread.
- **Hierarchy and honest state — pass.** The provider setup action is available
  while Send is disabled. Send/Stop and readiness still derive from actual
  component state. No new status colors or simulated production states.
- **Focus — pass for the exercised checks.** Input focus-visible styling was
  checked in both themes using the renderer's forced pseudo states. Typing,
  menu clicks and Escape were exercised with browser input events.
- **Error/recovery and native provider interaction — not re-audited.** This
  change does not establish installed-app or authenticated-provider acceptance.

## Validation

Desktop TypeScript, UI-token checks, chat-style ownership/budget, workbench
source smoke and `git diff --check` passed. The renderer passed its 48-state
matrix; final targeted runs passed 12 setup states and four input hover/focus
states. The refactor pixel baseline was not rewritten for this intentional
visual change.

## Screenshots

[Provider setup, light](../screenshots/2026-11-11-composer-reference/provider-setup-light.png)
· [Connected, light](../screenshots/2026-11-11-composer-reference/connected-light.png)
· [Connected, narrow dark](../screenshots/2026-11-11-composer-reference/connected-dark-narrow.png)

These use the production React UI and styles with invented local fixture data.
The installed application was not rebuilt or replaced. Existing unrelated
working-tree changes were preserved.
