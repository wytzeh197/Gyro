# Gyro launch film

This directory is the permanent repository home for the current public-facing
Gyro launch film.

## Deliverables

| File                     | Purpose                                    | Delivery specification                                                         |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `gyro-launch-film.mp4`   | GitHub, launch-page, and social web master | 22 seconds, 1920×1080, 30 fps, H.264 High Profile, yuv420p, BT.709, AAC stereo |
| `gyro-launch-poster.png` | Repository preview and launch thumbnail    | 1920×1080 PNG                                                                  |

The web master uses an original procedural sound bed with transition whooshes
and low-frequency impacts. It contains no licensed music or voiceover.

## Creative direction and rights provenance

- The teaser is built from real Gyro UI captures and the Gyro logo, not
  generated interface footage.
- Chat, CLI, and Workspace plates use the README and site product captures in
  `docs/screenshots/readme/` and `site/assets/screenshots/hero-2400.webp`.
- The Gyro mark is `packages/ui/src/assets/gyro-logo-transparent.png`.
- Provider marks are the same SVGs the public site uses for Claude Code, Codex,
  Gemini CLI, Grok Build, Kimi Code, and Ollama. Each mark is a trademark of
  its owner and appears only to identify the agents Gyro already supports.
- Typography is Inter and Inter Tight from the vendored site fonts.
- Motion, compositing, and procedural sound design are original to Gyro.

The three abstract stills in `plates/` are the previous cinematic film's art
direction. The current renderer does not use them.

## Rendering

Run `pnpm launch:teaser` from the repository root to rebuild both deliverables.
The renderer captures compositor plates with a local Chromium (Chrome, Brave,
Edge, or `GYRO_CAPTURE_BROWSER`), then composites them with FFmpeg. It needs
Node.js, FFmpeg, and those product screenshot and logo assets.

Compositor source lives in `scripts/launch-teaser/`. Intermediate plates are
written to a temp directory and discarded after the encode.

## Repository policy

Keep these stable filenames when replacing the active launch assets so links in
`README.md` and `docs/launch.md` continue to work. Do not commit ProRes
mezzanines, frame sequences, render caches, or production scratch files here;
archive those outside normal Git history or introduce an explicit large-media
workflow first.

Current SHA-256 checksums:

- `gyro-launch-film.mp4`: `1d2565fe65e70a88554519e5e3e46b35c39ec48b54fa1b37a9c709aaf3515624`
- `gyro-launch-poster.png`: `ead6e4c811f647b5a14c09bee10464da39c89bacb8c9c423e466e66d4df7fe1e`
