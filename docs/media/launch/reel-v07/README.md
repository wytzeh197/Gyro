# Gyro v07 — sustained motion revision

V07 keeps the approved 15-second story and native UI assets. It replaces the short stop/start transitions with continuous curved paths, perspective and depth, longer convergence, a single move into the Review proof, and a slower workspace pullback. Sound is recomposed around longer swells and fewer sharp accents.

## Edit and reproduce

- `index.html`: typography, palette and layer structure.
- `film.js`: cubic motion paths, perspective, native masks, crop anchors and reading holds. Intermediate travel keys retain velocity; marked reading holds stop.
- `timeline.json`: frame format and narrative/sound cue times.
- `sound.py`: original deterministic stereo synthesis.
- `finish-audio.mjs`: oversampled mastering and decoded AAC verification.
- `render.mjs`, `encode.mjs`, `verify.mjs`: deterministic browser render, final media encoding and output checks.

Requirements: macOS for the same native system font, Node 24+, Brave Browser, FFmpeg and Python 3 with NumPy. Native UI assets are preserved at 4× resolution from the v06 isolated development-harness session. They are included, so no production app server is required to recompose the video. The original harness capture source remains in the Gyro repository at `scripts/gyro-reel-v06/capture.mjs`.

From this package's root, start a local static server:

```sh
python3 -m http.server 1428 --bind 127.0.0.1
```

In another terminal:

```sh
node scripts/gyro-reel-v07/launch.mjs
```

Then render as needed:

```sh
python3 scripts/gyro-reel-v07/sound.py
node scripts/gyro-reel-v07/finish-audio.mjs
node scripts/gyro-reel-v07/render.mjs boards
node scripts/gyro-reel-v07/render.mjs animatic
node scripts/gyro-reel-v07/encode.mjs animatic
node scripts/gyro-reel-v07/render.mjs final
node scripts/gyro-reel-v07/encode.mjs final
node scripts/gyro-reel-v07/verify.mjs
```

Preview: `http://127.0.0.1:1428/scripts/gyro-reel-v07/index.html?play=1`.

The final renderer captures at 2× resolution and downsamples to 1080p. The final 120 frames are identical, including after encoding: the closing segment uses constant-QP intra pictures. Audio uses the tested `fast` AAC coder to avoid an opening-transient overshoot observed with this local FFmpeg build's default coder.

No native UI interiors are rebuilt. Uniform planar scale and perspective operate on original native pixels; Review's closer view changes a crop, not internal proportions. Development fixture content is staged and makes no task-speed claim. No production API or component-export changes are part of v07.

Verified delivery: 15.000 seconds, 1920×1080, 60 fps, stereo 48 kHz AAC. The last 120 decoded frames form an exact two-second still. See `docs/media/launch/reel-v07/verification.json` and `qa-review.md`.
