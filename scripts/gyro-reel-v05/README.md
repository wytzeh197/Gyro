# Gyro launch film v05

Editable, code-native 15-second film: 1920 × 1080, 60 fps, stereo sound. A pale blue-white stage carries one continuous camera journey through Gyro's real composer, Review view, editor and terminal, ending on “Gyro.” and “Coming soon.”

## UI and timing

The browser runs Gyro's development capture entrypoint with `scene=chat&theme=light&reset=1&reel=1`. The app renders its existing components, fonts, icons, syntax highlighting, diff styling and terminal. `film.js` wraps the rendered app with the camera, blue edge, lighting and brand ending; it does not redraw the product as a screenshot mockup.

App-side additions are restricted to the development capture fixture. The composer send handler, file review, editor and terminal follow the actual UI interaction path. The current app uses Review → Compare current file → Open file to reach the editor; the native terminal tab is labelled Shell. These exact controls are used without renaming or redrawing them. Fixture timing is staged for the edit, **not a task-performance benchmark**. The native demo run reports **38 seconds**; its result is revealed within the 15-second film.

| Seconds | Picture and movement |
| --- | --- |
| 0–2 | Blue edge rotates into the actual Gyro window. |
| 2–4 | Push into the composer; “Limit retries. Add a test.” is entered and sent. |
| 4–6 | Reveal the result, then travel into `src/sync.js` Review with the retry limit changing to `5`. |
| 6–8 | Open the editor and settle on the changed line. |
| 8–10 | Sweep down to the terminal and the “2 passed, 2 total” result. |
| 10–12 | Pull back to the complete workspace, then turn the window edge-on. |
| 12–13 | Blue sweep reveals the supplied Gyro mark and name; “Coming soon.” appears. |
| 13–15 | Hold the closing composition while the original sound fades. |

## Reproduce and edit

Requirements: workspace dependencies installed with pnpm, Node.js 22 or newer with native WebSocket support, Python 3 with NumPy, FFmpeg, and Brave Browser at the macOS application path used by `launch.mjs`.

Run from the repository root. Start the Vite development server and leave it running:

```sh
pnpm --filter @gyro-dev/desktop dev --port 1427 --strictPort
```

In another terminal, launch the isolated capture browser and leave it running:

```sh
node scripts/gyro-reel-v05/launch.mjs
```

The browser uses a temporary profile and exposes the Chrome DevTools Protocol on local port **9348**. Stop this launcher after rendering to close the browser and remove its temporary profile.

In a third terminal, synthesize the score, render the deterministic timeline, then encode:

```sh
python3 scripts/gyro-reel-v05/sound.py
GYRO_DPR=2 node scripts/gyro-reel-v05/render.mjs
bash scripts/gyro-reel-v05/encode.sh
```

Use `node scripts/gyro-reel-v05/render.mjs --preview` for a sparse preview before the full render. Both camera and app events use the same 900-frame clock. Native UI is mounted at its untransformed geometry before each camera move, preserving editor and terminal sizing. Double pixel density renders 3840 × 2160 source frames, then the encoder downsamples to the requested 1920 × 1080.

Edit camera keyframes and presentation in `film.js`, interaction timing in `render.mjs`, and sound cues in `sound.py`. Rendered frames, score and delivery files belong in `docs/media/launch/reel-v05/`.

## Sound and finishing

`sound.py` synthesizes the entire score with seeded NumPy noise and oscillators: suspended tonal fields, sparse glass notes, panning air gestures and tactile UI ticks. No external samples, recordings or voice are used. The output is a 15.000-second stereo 48 kHz WAV with a clean final fade.

First-pass FFmpeg measurement is stored in `docs/media/launch/reel-v05/loudness-pass1.log`. Apply this filter when encoding the source WAV:

```text
loudnorm=I=-15:TP=-1.5:LRA=9:measured_I=-19.22:measured_TP=-3.10:measured_LRA=2.90:measured_thresh=-29.63:offset=-0.33:linear=false
```

The filter's measured output before delivery encoding is −14.90 LUFS integrated and −1.50 dBTP. Re-measure after changing the score or encoding settings. Final video QA must inspect the encoded result for interaction order, UI fidelity, reading holds, clipping, camera continuity, sound alignment, exact duration and the closing hold; this README does not certify those checks.
