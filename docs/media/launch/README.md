# Gyro launch film

This directory is the permanent repository home for the current public-facing
Gyro launch film.

## Deliverables

| File | Purpose | Delivery specification |
| --- | --- | --- |
| `gyro-launch-film.mp4` | GitHub, launch-page, and social web master | 22 seconds, 1920×1080, 30 fps, H.264 High Profile, yuv420p, BT.709, silent |
| `gyro-launch-poster.png` | Repository preview and launch thumbnail | 1920×1080 PNG |

The web master is intentionally silent. It contains no music, voiceover, sound
effects, captions, or audio stream.

## Product and rights provenance

- Product footage uses current first-party Gyro Chat, CLI, IDE, Permissions,
  and Providers captures.
- The logo comes from `packages/ui/src/assets/gyro-logo-mark.png`.
- Motion, typography, and compositing are original to Gyro.
- No stock, externally licensed, or generated media is included.

## Repository policy

Keep these stable filenames when replacing the active launch assets so links in
`README.md` and `docs/launch.md` continue to work. Do not commit ProRes
mezzanines, frame sequences, render caches, or production scratch files here;
archive those outside normal Git history or introduce an explicit large-media
workflow first.

Current SHA-256 checksums:

- `gyro-launch-film.mp4`: `9cc64d44ae4504ccc3513b73c54dfec3a847baf881f6cbdf27392efa73edfba2`
- `gyro-launch-poster.png`: `b28e4ac17f5dd34800c6d7d69380fbd2edf6062bb848ba0c64edf793f4cfc275`
