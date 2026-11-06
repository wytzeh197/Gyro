# Gyro — All in one / v04

A minimal 15-second redesign based on the user's supplied first Gyro video, `CaIPyUT2p351fHt8.mp4`. Keeps the previous request for blue tones and stronger visible motion. No date, version number, or immediate availability claim.

## Creative direction

Compact centered type, abundant pale blue-white space, six provider marks, one product surface in focus, and a quiet Gyro / Coming soon landing. Product choreography is the primary engine; typography is secondary. The motion comes from curved icon paths, convergence, a dot handoff into the composer, camera travel, sliding tab emphasis, and components joining into a workspace. No persistent brand header, badge montage, saturated stage changes, or decorative grain.

The explicit redesign request authorizes the concept. Style frames were reviewed before the full render; the assembled editor and terminal positions were corrected to stay within the workspace shell.

## Narrative clock and transcript

| Time | Copy / subject | Motion |
| --- | --- | --- |
| 0–1.95 | Meet Gyro. | Small type reveal and camera push |
| 1.35–4.55 | Bring your own. | Six provider marks enter on curved paths, turn, and gather into one point |
| 4.05–6.45 | Chat | Blue point leads into a composer; camera pushes and moves laterally; source prompt is revealed |
| 5.95–8.25 | Terminal | Incoming card turns toward camera while the previous surface recedes |
| 7.72–10.25 | Workspace | Camera continues into the light editor; tab underline travels with the selected surface |
| 9.80–12.85 | All in one. | Chat, terminal, and editor assemble in one shell during a camera pullback |
| 12.08–15 | Gyro. Coming soon. usegyro.io | Workspace contracts, logo resolves, small closing copy settles |

The overlapping times are deliberate transitions. The interface is a staged product illustration, not a recording of elapsed task completion time. UI microtext is contextual; viewers only need the larger copy and mode labels to understand the story.

## Assets / evidence

- User reference supplies the original visual direction and a terminal image extracted at 10.7 seconds, cropped to the existing terminal panel.
- Editor image: `docs/design-polish/2026-09-26/editor-light.png`, cropped to its real editor surface.
- Composer and prompt: existing crops from `docs/screenshots/site-v4/website-conversation-light.png`. These are demo-fixture captures; see `docs/screenshots/site-v4/README.md`.
- Six provider SVGs: existing `site/index.html` agent grid, matching the providers listed in the repository README. Existing provider marks imply compatibility only.
- Gyro mark: `packages/ui/src/assets/gyro-logo-transparent-dark.png`.
- Fonts: existing bundled Inter.
- “Bring your own” and “All in one” match the reference and repository's product description. “Coming soon” follows the user's explicit launch wording.
- Presentation shell and navigation are editorial staging of the supplied surfaces, not a claimed exact live application state.

No reference audio is copied. Original simplified score and sound cues are synthesized locally, with no purchased sounds, stock samples, or voice. Important meaning is all on screen; no speech captions are needed. The table above is the visual transcript.

## Rebuild

```sh
node scripts/gyro-reel-v04/render.mjs docs/media/launch/reel-v04/frames
python3 scripts/gyro-reel-v04/sound.py
bash scripts/gyro-reel-v04/finish.sh
```

Requires a local Chromium-family browser, Node with built-in WebSocket, Python/NumPy, and FFmpeg. Serve the repository over HTTP to preview `scripts/gyro-reel-v04/index.html`; `?render` disables the loop and `window.draw(seconds)` picks an exact frame. GYRO_FRAME_START/GYRO_FRAME_END can render a range. 1920×1080, 60 fps, 900 deterministic frames. Previous versions are preserved.
