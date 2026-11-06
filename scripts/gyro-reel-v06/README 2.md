# Gyro v06 — One task. One workspace.

Editable, deterministic HTML/CSS motion composition with faithful native app captures and an original synthesized stereo soundtrack. No production component exports or API changes were made for v06.

## Edit

- `index.html`: typography, palette and layer structure.
- `film.js`: frame-based object choreography, masks, native crop transforms and proof holds.
- `timeline.json`: master format and named narrative/audio cues. Detailed visual keys are authored in `film.js` around those cue times; update both when changing scene timing.
- `sound.py`: original deterministic audio synthesis, using the named timeline cues.
- `finish-audio.mjs`: oversampled limiting and decoded AAC validation.
- `capture.mjs`: three isolated development app contexts and native region extraction. Default native capture DPR4.
- `render.mjs`: browser rendering. Final defaults to DPR2, then FFmpeg downsamples to1080p.
- `encode.mjs` / `verify.mjs`: encode and inspect the final media.

Requires macOS for the exact native system typography, Node24+, FFmpeg, Brave Browser, and Python3 with NumPy for rebuilding sound. Captured assets can be recomposed without running the Gyro app. Refreshing the captures requires the original Gyro repository and its development `reel=1` fixture.

## Reproduce in the Gyro checkout

From the repository root, start the app capture server:

```sh
pnpm --dir apps/desktop exec vite --host 127.0.0.1 --port 1428
```

In another terminal, start the isolated browser:

```sh
node scripts/gyro-reel-v06/launch.mjs
```

Then run as needed:

```sh
CAPTURE_DPR=4 node scripts/gyro-reel-v06/capture.mjs
python3 scripts/gyro-reel-v06/sound.py
node scripts/gyro-reel-v06/finish-audio.mjs
node scripts/gyro-reel-v06/render.mjs boards
node scripts/gyro-reel-v06/render.mjs animatic
node scripts/gyro-reel-v06/encode.mjs animatic
node scripts/gyro-reel-v06/render.mjs final
node scripts/gyro-reel-v06/encode.mjs final
node scripts/gyro-reel-v06/verify.mjs
```

## Standalone source bundle

The bundle preserves the paths used by the composition and includes native PNGs, original score, logo, source and review notes. From its root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/scripts/gyro-reel-v06/index.html?play=1` to preview. Start `launch.mjs` in a separate terminal for headless rendering, then:

```sh
GYRO_FILM_URL=http://127.0.0.1:8000/scripts/gyro-reel-v06/index.html node scripts/gyro-reel-v06/render.mjs final
node scripts/gyro-reel-v06/encode.mjs final
```

Rendering produces temporary JPEG sequences in `/tmp/gyro-v06-*-frames`. Master frame780 is repeated through899 for a120-frame closing hold. The closing segment uses constant-QP intra encoding so the decoded hold is also pixel-identical. AAC uses the verified fast coder to avoid an initial-packet overshoot observed with the default coder in this local FFmpeg build. Capture assets retain native interiors; only the outer framing, masks, translation, scale and rotation are editorial. The demo result is staged and makes no elapsed task-speed claim.

The audio is measured and checked for clipping and a clean fade. A subjective real-time headphone review remains a human review step; the tools used here do not provide listening perception.
