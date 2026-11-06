# Gyro website visual system

Original coast artwork surrounds fresh captures of the current Gyro React UI. Two 13-second, silent films move through the completed conversation, expanded activity log, and companion review. These are edited sample states, not a real-time agent run. The website labels the sequence as a sample and retains readable HTML feature previews below it.

## Reproduce

With the desktop Vite server running on port 1420:

```sh
node scripts/capture-site-screenshots.mjs --keep-png
python3 scripts/site-motion/render.py
node scripts/check-download-site.mjs
node scripts/build-download-site.mjs
```

Requires Chromium/Brave, Node, Python 3, FFmpeg, and cwebp. Raw screenshots are in `docs/screenshots/site-v4`. `brief.json` and `timeline.json` describe the sequence. The renderer leaves full-size composition frames in a temporary directory for inspection.

## Deliverables

- `site/assets/motion/workflow-dark.mp4`: 13 seconds, 1600×1000, 24 fps, H.264/yuv420p, 1,029,143 bytes.
- `site/assets/motion/workflow-light.mp4`: same format, 1,026,473 bytes.
- `site/assets/screenshots/hero-{600,1200,2400}.webp` and matching `hero-light-*`: responsive 16:10 posters.
- `site/assets/gyro-coast.webp`: original generated backdrop.

Intentional silence: no audio track, speech, or captions. Actual UI copy provides the narrative. The on-page download control is the CTA. The website lazy-loads only the visible theme's film, pauses offscreen, provides a play/pause button, and defaults to posters for reduced motion or data saving.

## Reference and provenance

Reviewed https://cursor.com/ on September 11, 2026. Its large product windows, quiet framing, and atmospheric surroundings informed the composition. Much of the inspected site uses HTML interface demonstrations rather than embedded video. No Cursor images, footage, or source were reused.

The coast was created with the built-in image generation tool, then compressed to `site/assets/gyro-coast.webp`. The exact prompt is saved in `coast-prompt.txt`. The product UI was captured from this checkout's development fixture with synthetic Aurora project data; no real chats or credentials were captured.

## Verification

Both complete films were decoded into half-second contact sheets and visually inspected, including all dissolves and the return to the first frame. Both exports were checked with ffprobe for dimensions, duration, frame rate, codec, and absence of audio. Browser checks covered playback, explicit pause/resume, theme switching while paused, offscreen pause, and layout at 1440, 390, and 320 pixels. Website checks and static build pass. Reduced-motion and data-saving defaults were reviewed in the playback source; OS preference emulation was not part of the browser check.
