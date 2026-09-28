# Gyro launch v05 — capture and verification

The film uses the running development capture app at a native layout size of 1920 × 1080. Frames are rendered at device pixel ratio 2 and downsampled for the 1080p master. The app's components are never replaced with screenshot panels. Only the outer stage, camera, edge, pointer and closing title are custom motion graphics.

## Product fidelity

One deterministic demo session supplies the prompt, response, recorded patch, current file and terminal. The actual composer submits the prompt. The app then follows its supported route: edited-file card → Review → Compare current file → Open file → native Monaco selection → workspace panel → Shell. The current app labels the editor action **Open file**, rather than the plan's descriptive “Open in editor.”

The fixture contains a one-line `Infinity` → `5` change in `src/sync.js`. The terminal's “2 passed, 2 total” is existing staged demo output; it is not a benchmark or a claim that this video ran production tests. The completed run displays **Worked for 38s**, while editorial timing compresses the journey into 15 seconds. No date or release version is announced.

Native and camera-wrapped identity frames were captured at matching dimensions. Cropped comparison SSIM scores on the final high-density render: Review 1.000000; editor 1.000000; terminal 0.999544; composer 0.997587; response 0.998409. Source geometry, font choices, controls, syntax colours and native selection styling are preserved. Camera transforms are reset before mounting/focusing new surfaces, preventing transformed measurements from changing editor or terminal layout.

## Motion and image review

The approved sequence was inspected through a sparse preview and key full-resolution frames. Two early blank handoffs and a faint edge were corrected before the final render. The revised send transition retains the sent prompt; the editor handoff uses a short continuous camera travel; terminal output is inset from the frame edge. The opening and receding window have a visible blue edge.

All 900 camera poses are finite, sampled at 1/60 second. Quintic easing has continuous position and velocity at segment boundaries. Motion blur is restricted to travel. The native editor line and terminal result have settled reading pauses. The final 120 source frames are identical, yielding the requested two-second closing hold.

## Sound and technical checks

The score is original deterministic NumPy synthesis, with no sampled music, voice or external recordings. See `cue-sheet.md` for exact cues and provenance. Measured encoded audio: **−14.91 LUFS integrated, −1.49 dBTP**, stereo 48 kHz. No speech requires captions; the essential product and launch text is visible without audio.

`technical-qa.json` records the final file's dimensions, duration, frame count, frame rate, audio channels, sample rate, hold check and SHA-256. `media-check.log` records full-file decoding, black-frame, freeze and silence detection. Full decode completed without errors or black-frame flags. Freeze detection flags correspond to the intentionally sparse edge (0–1.1s), response hold (4.57–5.13s), editor hold (6.5–7.6s), terminal hold (8.82–9.62s), and edge/brand ending (11.67s onward). The last 0.24s of near-silence is the designed fade.

Visual review and automated sound measurements were performed. A human real-time headphones/speaker audition was not performed through these tools; no claim of that review is made.

## Editable delivery

Source is in `scripts/gyro-reel-v05/`, with reproduction instructions in its README. The ZIP contains those primary source files and the development capture fixture for use inside this Gyro repository. No production API change, deployment, publication, or external messaging is part of this delivery.
