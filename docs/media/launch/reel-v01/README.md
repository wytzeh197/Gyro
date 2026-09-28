# Gyro — In orbit

15-second introduction, 1920×1080, 30 fps. User-authorized creative direction: ambitious motion graphics, introduce Gyro, suggest an imminent launch without a release date. No release number or availability claim appears.

## Creative and evidence

The thesis is that Gyro brings agent chat, CLI, and IDE into one workspace. The spinning gyroscope motif makes that consolidation visual. Primary engine: kinetic typography. Secondary: orbital metaphor. Alternative directions considered: pure product choreography (too much detail for 15 seconds), and abstract logo-only reveal (insufficient product context). Assumed destination: horizontal web/social master, no platform-specific placement specified.

The repository README supports Chat / CLI / IDE, one workspace, and continuing the same session. Product imagery is the existing `docs/screenshots/readme/workspace-review.webp`, unmodified inside its moving picture frame. It is a product glimpse, not a demonstration of an interaction. Branding and bundled Inter fonts come from the existing repository. No third-party customer logos, metrics, dates, or invented interface states are used. “Soon” comes directly from the user's request.

## Locked sequence / visual transcript

| Time | Copy | Motion and sound |
| --- | --- | --- |
| 0–3 | A new center of gravity. Meet Gyro. Your agents. In orbit. | Chrome/coral projected gyroscope; masked type entrances; bass and glass arpeggio |
| 3–6.25 | Chat. CLI. IDE. Three ways to work. | Warm paper field, stepped typographic emphasis, rotating orbit geometry |
| 6.25–8.5 | One workspace. | Three labels converge, hero copy replaces them, harmonic lift |
| 8.5–11.75 | Built around your flow. Stay in the same session. | Real workspace screenshot moves into place; coral circular wipe |
| 11.75–15 | Gyro. Chat, CLI & IDE. In one orbit. Soon. usegyro.io | Logo lockup, slowing orbit, three-note sonic resolution and fade |

Persistent edge labels: “Gyro / Introducing”, “Chat / CLI / IDE”, “One workspace. Your agents.”, “Soon”. These are decorative; core meaning is repeated in large type. No speech or audio-only information; the transcript above carries all meaningful visual copy.

## Motion / sound

120 BPM pulse, deterministic frame clock, quartic entrances, smooth convergence, one dominant move per scene. Charcoal, warm white, coral. Large-type holds, two main brightness changes rather than rapid strobing. Original NumPy synthesis with seed 417; no downloaded samples or voice. `score.wav` is the unmastered stereo score. The MP4 contains the loudness-treated final mix.

## Rebuild

From the repository root:

```sh
node scripts/gyro-reel/render.mjs docs/media/launch/reel-v01/frames
python3 scripts/gyro-reel/sound.py
bash scripts/gyro-reel/finish.sh
```

Requires local Chromium-family browser, Node with built-in WebSocket, Python/NumPy, and FFmpeg. Source compositor: `scripts/gyro-reel/index.html`; serve the repository over HTTP to preview the continuous loop. Use `?render` to disable autoplay and `window.draw(seconds)` for deterministic inspection. This follows the existing local Canvas/Chromium + FFmpeg pipeline rather than adding a framework dependency.

Editable source and the original earlier launch film are preserved. This is a horizontal master; vertical distribution needs a recomposed layout.
