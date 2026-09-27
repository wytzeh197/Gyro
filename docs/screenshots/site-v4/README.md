# Website product visuals

The visuals under `site/assets/screenshots/` are **generated**, not hand-made.
They are captures of the real Gyro UI rendered in a browser against a fake Tauri
IPC layer, so every release can be re-shot from the current build.

## Regenerating

```bash
pnpm --filter @gyro-dev/desktop dev      # in one shell
node scripts/capture-site-screenshots.mjs
```

Add `--origin http://127.0.0.1:1427` if Vite is running on a different port.
Add `--keep-png` to leave the full-resolution PNGs in this directory, or
`--scene current-chat-light` to re-shoot a single surface.

## Current website set

Captured on 2026-09-27 from the working tree based on `9f4c893`
(`release/v0.1.0-alpha.49.7`), using the current production UI components and
synthetic capture fixtures. The installed Gyro interface was also inspected
to confirm the current navigation and composer design.

- `current-chat-{light,dark}.webp`: conversation, completed task, and composer.
- `current-workspace-{light,dark}.webp`: Explorer, source editor, and Shell.
- `current-review-{light,dark}.webp`: conversation and recorded change review.
- `site/assets/social-preview.png`: current review view for link previews.

The six product screenshots are 2880 × 1800 pixels (1440 × 900 at 2×).
The social preview is 1200 × 630. The site build includes only these six
product screenshot files; older captures kept in the source directory are
excluded from the published assets.

## How it works

- `apps/desktop/capture.html` is a dev-only Vite entry. `vite build` only takes
  `index.html`, so it never ships in the app bundle.
- `apps/desktop/src/capture-fixtures.ts` installs `window.__TAURI_INTERNALS__`
  before the app boots and answers each command with demo data.
- `scripts/capture-site-screenshots.mjs` drives a Chromium browser over the
  DevTools protocol: it selects the theme, runs a deterministic demo task,
  opens the current production controls, and encodes the WebP captures.

The script fails if a scene renders the app's error boundary or is missing
required UI landmarks, and prints any command that still needs a fixture.

## Content

All demo content is invented — the `aurora` project, its sync-queue retry work,
the session titles, and the provider logins. Nothing reads a real session,
repository, or provider account, so the output is safe to publish.

`scripts/check-download-site.mjs` pins the exact WebP dimensions; if you change
a scene's size there, change it in the checker too.
