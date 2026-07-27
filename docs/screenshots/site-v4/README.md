# Website product visuals

The visuals under `site/assets/screenshots/` are **generated**, not hand-made.
They are captures of the real Gyro UI rendered in a browser against a fake Tauri
IPC layer, so every release can be re-shot from the current build.

## Regenerating

```bash
pnpm --filter @gyro-dev/desktop dev      # in one shell
node scripts/capture-site-screenshots.mjs
```

Add `--keep-png` to leave the full-resolution PNGs in this directory, or
`--scene chat` to re-shoot a single surface.

## How it works

- `apps/desktop/capture.html` is a dev-only Vite entry. `vite build` only takes
  `index.html`, so it never ships in the app bundle.
- `apps/desktop/src/capture-fixtures.ts` installs `window.__TAURI_INTERNALS__`
  before the app boots and answers each command with demo data.
- `scripts/capture-site-screenshots.mjs` drives Chrome over the DevTools
  protocol: it seeds the dark theme, clicks the UI into the state to photograph,
  captures at the master size, and encodes the responsive WebP variants.

The script fails loudly if a scene renders the app's error boundary, and prints
any command that still needs a fixture.

## Content

All demo content is invented — the `aurora` project, its sync-queue retry work,
the session titles, and the provider logins. Nothing reads a real session,
repository, or provider account, so the output is safe to publish.

`scripts/check-download-site.mjs` pins the exact WebP dimensions; if you change
a scene's size there, change it in the checker too.
