You are continuing UI work on Gyro (a Tauri + React desktop app) in /Users/wytze/Gyro, branch v0.1.4.

## Ground rules
- Do not commit or push unless asked.
- The working tree has many unrelated uncommitted changes (editor, sessions, sqlite, settings, etc.). Touch only the files listed below. If a listed file also has unrelated hunks (surfaces.tsx and workspace-sidebar.tsx do), edit only the parts named here.
- Keep these preview files: apps/desktop/src/remote-access/design-options.tsx, design-options.css, apps/desktop/remote-access-options.html, apps/desktop/remote-access-preview.html.
- Design system rules:
  - Use only `--gyro-*` semantic tokens: no hex and no new raw values.
  - Use only components that already exist (gyro-primary-button, gyro-secondary-button, SettingsStatus, …).
  - At most one primary button per state.
  - Green, amber, red and blue are for status only.
  - Status text is read from data.
  - Every block has loading, empty and error states.
  - If a value or decision is missing, ask instead of guessing.
- Format with `npx prettier --write <file>`.

## What was done
The work is the remote access feature: using Gyro on one Mac from another Mac.

Goal of the latest change: a remote chat looks exactly like a normal chat. All remote info and controls for a chat live in that chat's Environment card: the right rail, `ChatEnvironmentCard` with `placement="panel"`. This covers:
- host status
- the location line
- refresh
- the watching / take-control notice
- Reconnect when offline
- approvals
- error notices

The old remote top bar and banners were removed.

Separately, the sidebar's "Machine" picker now sits below the window bar. The Hide sidebar button and the surface switcher stay at the very top, where the macOS traffic lights are.

## Where the changes are

Shared UI (packages/ui/src):
- `chat-environment-card.tsx`: the panel branch, starting after `remotePrimary`. It adds:
  - `remoteDot` (status dot class)
  - `remoteDown`: when the remote is offline or connecting, the header shows `remote.statusLabel` instead of the local "Ready"
  - `remoteMeta`: one line, "Connected · Experimental · <location>", with `role="status"`
  - `showBranchRow`: hides the branch row for a remote chat with no source-control data
  - `hasRows`: no empty rows box
- `chat-environment-card.css`: the `.gyro-env-panel-remote*` rules, around lines 676–745. Gaps now use `--gyro-space-compact` / `--gyro-space-standard`. The rest still uses raw px (2/5/6/14/24/28px), as the rest of that file does.
- `remote-access-context.tsx` (new): context slots `MachineNavigation` and `RemoteAccessSettingsContent`, provided by the desktop app.
- `surfaces.tsx`: removed `<MachineNavigation />` from `<aside className="gyro-sidebar">`. The import is now just `RemoteAccessSettingsContent`.
- `workspace-sidebar.tsx`: imports `MachineNavigation` and renders it right after the closing `</div>` of `gyro-sidebar-persistent-header`.

Desktop remote access frontend (apps/desktop/src/remote-access/, all new):
- `root.tsx`: `RemoteWorkspaceRoot` (mounted in apps/desktop/src/main.tsx). It provides the context slots, including the `.gyro-remote-navigation` Machine select and the "Connect to a Mac…" button.
- `workspace.tsx`: the remote chat view. It builds `environmentRemote` for the Environment card, `toggleEnvironment`, the notices stack and the home head.
- `workspace-review.tsx`: `CommandApprovalCard` and `MutationReviewPanel` (diff review).
- `workspace-panels.tsx`: the Files, Source Control and Terminal side panels.
- `settings.tsx`: the Remote access settings page, with pairing, invite and connected devices.
- `use-workspace.ts`, `client.ts`, `context.ts`, `ports.ts`, `types.ts`, `view-state.ts`: data, client and state.
- `remote-access.css`: the styles. The latest addition is `.gyro-remote-stack > .gyro-remote-banner { margin: 0; }`.
- `preview.tsx`, `preview-ports.ts`: a browser preview with a fixture. In devtools:
  - `window.gyroRemoteFixture.setOnline(false)`
  - `window.gyroRemoteFixture.addApproval()`
- `design-options.tsx/.css`: design option previews. Keep them.

Backend (new):
- `crates/gyro-remote/`: protocol, transport, control, store.
- `apps/desktop/src-tauri/src/features/remote_access/`: Tauri commands, dispatch, workspace, mutation locks, smoke tests.

Other:
- `docs/plans/remote-access-implementation-2026-11-13.md`: the implementation plan.
- `scripts/check-remote-access-browser.mjs`, `scripts/check-remote-access-client.mjs`: checks.
- `.claude/launch.json`: the "desktop-remote-preview" entry runs vite on http://127.0.0.1:1449. In the preview, click "Connect", then "Existing remote chat"; "Take control" takes control.

## How to verify
- `cd apps/desktop && pnpm typecheck`
- `node scripts/check-ui-tokens.mjs` (from the repo root)
- `node scripts/check-remote-access-client.mjs` and `node scripts/check-remote-access-browser.mjs`
- Visually, in the 1449 preview, check these states in light and dark mode:
  - watching
  - in control with an approval waiting
  - Mac offline (header shows "Unavailable", red dot, Reconnect is the only primary)
  - the Files panel replacing the card, and the top-bar Environment toggle bringing it back

## Still open
1. Not yet visually re-checked:
   - the Files panel replacing the Environment card, and the top-bar Environment toggle bringing it back
   - the sidebar in dark mode after the Machine picker move
   - that the Settings page still shows no Machine picker
2. Raw px in `.gyro-env-panel-remote*` (chat-environment-card.css ~683–735) has no matching spacing tokens. Either keep the file's px convention or ask the owner for tokens; don't invent any.
3. Questions for the owner (don't guess):
   - an opacity token for the 0.55 dimmed text
   - dark mode mapping
   - the accent colour
   - the code/syntax palette
   - density
4. Keyboard order through the Environment card has not been tested end to end.
