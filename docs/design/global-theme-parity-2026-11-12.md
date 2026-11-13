# Global theme parity — 2026-11-12

The supplied light-mode screenshot showed the workspace-mode chip as a black block. Its hover background and foreground both resolved to `--gyro-text`. The welcome composer now uses surface, border, and control-hover tokens for those roles. Composer buttons also retain a visible keyboard-focus outline.

Existing graphite/porcelain colors, dimensions, typography, native material behavior, and appearance preferences are preserved. Legacy fixed colors in navigation, slash-command menus, terminal panels and menus, provider settings, project-removal dialogs, and update cards now follow the shared semantic tokens. This is a theme-consistency change, not a new palette.

## Task scope

- `packages/ui/src/chat.css`: welcome composer token correction and keyboard-focus rule only.
- `packages/ui/src/styles.css`: targeted legacy color replacements; no layout or behavior changes.
- `scripts/check-theme-parity-browser.mjs`: repeatable real-React browser fixture regression check.
- This QA note.

Both CSS files already contained unrelated work. Their full Git diffs are not this task's commit scope; preserve existing changes and stage only the theme hunks if a commit is later requested.

## Verification

- `node scripts/check-ui-tokens.mjs` — passed.
- `node scripts/check-workbench-ui.mjs` — passed.
- `node scripts/check-appearance-persistence.mjs` — passed.
- `node scripts/check-theme-parity-browser.mjs` — 24 cases, zero failures.
- Scoped `git diff --check` — passed.

Browser coverage: light/dark; 860×620 and 1440×900; compact/comfortable; small/default/large; a custom accent in large-size cases. Tested the workspace-mode chip resting, hovered, keyboard-focused, and expanded; menu contrast and Escape dismissal; explicit theme selection and System responding to both emulated OS preferences. Navigated actual fixture UI to chat, Appearance, Models & accounts, a fully loaded Monaco diff, and a terminal panel.

Measured workspace-mode hover text contrast: 15.47:1 light, 13.24:1 dark. These are measurements for that control, not an app-wide accessibility certification.

## Review-screen checklist

| Check | Result |
| --- | --- |
| Tokens and existing components | Pass: existing semantic palette and native HTML/React controls reused. |
| Relevant states | Pass: hover, focus, expanded menus, empty welcome, populated thread/settings/diff/terminal fixtures. |
| Status meaning | Pass in source: no status data or transitions changed; provider success styling follows the success token. |
| Action hierarchy | Preserved; no new primary actions. |
| Keyboard focus and menu dismissal | Pass for composer workspace controls; existing focus token and Escape handler. |
| Native app and live providers | Unverified; no app installation/rebuild or live provider invocation. |
| Every dialog/error/loading variant | Not exhaustively rendered; dialog color changes were source-reviewed. |

## Evidence

All screenshot content is synthetic capture-fixture data, rendered through production components.

- [Light welcome with hover/focus](../../artifacts/screenshots/theme-parity/welcome-light-1440-compact-default.png)
- [Dark welcome with hover/focus](../../artifacts/screenshots/theme-parity/welcome-dark-1440-compact-default.png)
- [Light Appearance](../../artifacts/screenshots/theme-parity/appearance-light-1440-compact-default.png)
- [Dark Appearance](../../artifacts/screenshots/theme-parity/appearance-dark-1440-compact-default.png)
- [Light providers](../../artifacts/screenshots/theme-parity/providers-light-1440-compact-default.png)
- [Dark providers](../../artifacts/screenshots/theme-parity/providers-dark-1440-compact-default.png)
- [Light diff](../../artifacts/screenshots/theme-parity/workspace-diff-light-1440-compact-default.png)
- [Dark diff](../../artifacts/screenshots/theme-parity/workspace-diff-dark-1440-compact-default.png)
- [Light terminal](../../artifacts/screenshots/theme-parity/cli-light-1440-compact-default.png)
- [Dark terminal](../../artifacts/screenshots/theme-parity/cli-dark-1440-compact-default.png)
- [Machine-readable results](../../artifacts/screenshots/theme-parity/results.json)

Run the browser check with the desktop Vite server on port 1420, or set `GYRO_TEST_ORIGIN` to a loopback server. `GYRO_CAPTURE_BROWSER` can select a Chromium executable. It uses and closes its own isolated headless profile.
