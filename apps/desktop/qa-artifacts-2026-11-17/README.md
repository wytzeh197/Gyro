# Design QA evidence harness — 2026-11-17

Report-only audit. No production implementation changes were made by this audit.

- Run from apps/desktop: `node node_modules/vite/bin/vite.js --config qa-artifacts-2026-11-17/vite.config.mjs --host 127.0.0.1 --port 1437 --strictPort`
- Open `/qa-artifacts-2026-11-17/index.html`.
- Synthetic 0/50 chat sessions and empty/50000-line file responses are confined to this harness.
- For Workspace scenes, select Workspace and open package.json; the scene does not automatically select a file.
- Terminal body is a preformatted stand-in, not xterm. No real PTY or remote connection is started.
- 2560x1440 is an emulated CSS viewport scaled to fit the display, not native fullscreen.
- Settings preview has a 32px fixture toolbar.
- Screenshot gallery: /Users/wytze/.codex/visualizations/2026/11/17/01a1e82f-9c2e-7933-985d-8808b4841610/index.html
- Terminal empty-state 1280 screenshot was excluded because its recorded viewport label remained 860x620.
- Workspace split minimum screenshot was excluded because the drag did not change geometry.
- Working tree was concurrently modified by other work; evidence is not a clean immutable build.
