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

- The teaser deliberately contains no product screenshots or interface footage.
- Cinematic 3D plates and abstract interface fragments introduce Gyro's
  connected Chat, CLI, and full IDE modes without revealing the interface.
- The logo comes from `packages/ui/src/assets/gyro-logo-mark.png`.
- Motion, typography, compositing, and procedural sound design are original to
  Gyro.
- The three visual plates in `plates/` were generated specifically for Gyro and
  then art-directed, cropped, graded, and composited locally. No stock or
  externally licensed media is included.

## Rendering

Run `pnpm launch:teaser` from the repository root to rebuild both deliverables.
The renderer requires FFmpeg and the standard macOS Arial fonts.

## Repository policy

Keep these stable filenames when replacing the active launch assets so links in
`README.md` and `docs/launch.md` continue to work. Do not commit ProRes
mezzanines, frame sequences, render caches, or production scratch files here;
archive those outside normal Git history or introduce an explicit large-media
workflow first.

Current SHA-256 checksums:

- `gyro-launch-film.mp4`: `c56362a9f23a7876c8e08a0b9e764e33b96699145de7dfbd0587b5d3a8cb0027`
- `gyro-launch-poster.png`: `d9f67649bf4576163f11ad6ef909ebc5c23d2b17767d7859bf4655dab686d385`
