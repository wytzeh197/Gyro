# Gyro website image revision — 2026-09-27

## Scope and provenance

The previous revision reused outdated product images. They have now been
replaced by fresh captures from the current source UI, based on commit
`9f4c893` on `release/v0.1.0-alpha.49.7`, with synthetic demo data.

The installed Gyro app was inspected to confirm the current navigation and
composer. All six light/dark chat, workspace, and review captures were then
generated through production UI components. The review screenshot now shows
recorded changes and “Compare current file”; the workspace shows the current
Explorer, editor, and Shell. Social previews were replaced as well.

## Evidence

- Capture command: `node scripts/capture-site-screenshots.mjs --origin http://127.0.0.1:1427 --keep-png` — completed successfully for all seven scenes.
- Product images: six `site/assets/screenshots/current-*.webp` files, each 2880 × 1800. Source PNGs are in `docs/screenshots/site-v4/`.
- Social preview: `site/assets/social-preview.png`, 1200 × 630, with a new cache version in all four pages' metadata.
- Build: `pnpm site:build` passed. The build includes the six new screenshots and excludes legacy screenshot files.
- Browser: built preview at `http://127.0.0.1:4173/` inspected at desktop 877 × 759 and mobile 390 × 844. Current hero and product screenshots loaded at their expected dimensions. Mobile review images used the selected light/dark theme and the page had no horizontal overflow at 390 px.
- Visual inspection: all six product captures and the social preview were inspected. No old Sessions/Workspace text switcher or obsolete review approval controls remain in these images.
- `pnpm site:check`: runtime and build safety checks passed; no image-specific assertions failed. The full check still reports five outdated homepage-copy assertions and three existing 12px text rules below its 13px minimum. These are outside this image revision.

This is an image revision check, not a blanket approval of all website design,
copy, or accessibility behavior.
