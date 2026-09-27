# Gyro — Keep your flow / v03

Rebuilt following the user's supplied motion-design reference, `/Users/wytzehemrica/Downloads/oOL0LwgaVbZv5S8i.mp4`. The reference is a 17.1-second, 60 fps four-up montage. Its useful principles are depth-staged UI, soft lighting, large type, different camera distances, and choreography of interface layers. No footage, audio, text, or brand assets were copied from it.

## Creative brief

Introduce Gyro in 15 seconds and hint at an imminent launch without a date or release number. Audience: people who build with agents. Product truth: Chat, CLI, and IDE share a workspace and session. Primary engine: product choreography. Secondary engine: kinetic type. Cool blue, icy white, and deep navy stages. Continuous dolly pushes, counter-moving lighting, changing camera yaw/pitch, floating triptych panels, directional blur transitions, and a gentle final push replace the earlier static holds.

This is a deterministic DOM/CSS motion-graphics composition with 3D camera transforms, original synthesized sound, and existing product screenshot layers. Interface crops are presentation choreography, not a live screen recording. No manufactured interaction results are introduced. The existing repository README supports all product claims. The two-passing-tests callout repeats the existing terminal screenshot, not a generalized performance claim.

## Timeline and visual transcript

| Seconds | Main copy | Composition |
| --- | --- | --- |
| 0–2.5 | Start with an idea. | Floating real composer and prompt, layered interface behind it, cursor approach |
| 2.5–5 | Chat. Make the first move. | Perspective full interface with its actual result card brought forward |
| 5–6.75 | CLI. Keep your tools. Keep your momentum. | Deep green scene, terminal macro, existing passing-tests result |
| 6.75–8.5 | IDE. See the work. Shape what's next. | Reverse camera angle, large workspace detail, files callout |
| 8.5–11.5 | One continuous flow. One session. All the way through. | Three product surfaces assemble, then converge |
| 11.5–15 | Meet your new workspace. Gyro. Your agents. Your workspace. Your flow. Coming soon. usegyro.io | Logo resolves from depth, warm gradient, deliberate closing hold |

Secondary copy: “Introducing”, “Your idea”, “A little thought. A lot of possibility.”, “Ready for your review.”, “2 passed, 2 total”, and “Your files. Your workspace.” Core meaning is on-screen; no voice or audio-only information requires captions.

## Source assets / rights

Existing project assets: Gyro app logo; bundled Inter and Inter Tight; `docs/screenshots/site-v4/website-conversation-light.png`, `docs/screenshots/readme/cli-workbench.webp`, and `docs/screenshots/readme/workspace-review.webp`. Source crops under `scripts/gyro-reel-v03/assets/` preserve actual image content. Standard presentation window frames and callout pills are editorial, not claimed product controls.

Original score: `scripts/gyro-reel-v03/sound.py`, seed 8027, 120 BPM, synthesized chords, plucks, bass, percussion, transitions, and final three-note signature. No downloaded samples, copied reference audio, voice, or purchased assets.

## Rebuild

```sh
node scripts/gyro-reel-v03/render.mjs docs/media/launch/reel-v03/frames
python3 scripts/gyro-reel-v03/sound.py
bash scripts/gyro-reel-v03/finish.sh
```

900 deterministic frames. Node with built-in WebSocket, Chromium-family browser, Python/NumPy, and FFmpeg required. Serve the repository over HTTP to preview `scripts/gyro-reel-v03/index.html`. `?render` disables the loop; `window.draw(seconds)` selects an exact time. Set GYRO_FRAME_START/GYRO_FRAME_END to render a frame range. This is the horizontal master; a vertical cut requires recomposition.

## Revision request

User requested visibly stronger camera movement and an overall blue palette. Card yaw now sweeps roughly 25–30 degrees within product shots, scale increases continuously, scene cameras translate and push throughout shots, triptych panels float independently, and all editorial lighting/accent colors are blue. Original product screenshot colors are preserved.
