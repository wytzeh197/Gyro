# Gyro v06 — One task. One workspace.

## Creative thesis

A 15-second teaser for developers whose work moves between conversation, code, and terminals. Scattered work becoming one workspace is the central visual event: the opening establishes a problem, the fragments converge, and the authentic Gyro product resolves it. Native product evidence then supports the promise.

The design uses a pale blue-white stage, navy display type, restrained cobalt selection accents, changes in scale, independently moving UI fragments, and short readable pauses. The recurring selection rectangle connects the opening task to the shared workspace alignment. The film closes with the actual Gyro mark, “Gyro.” and “Coming soon.” No launch date or version number is asserted.

## Approved shot sequence

| Time | Visual intent |
|---|---|
| 0–1 s | “One task.” lands in two precise beats. A blue selection highlights *task*. |
| 1–2 s | The highlight expands into the actual task fragment, “Limit retries. Add a test.” Native code and Shell fragments arrive from separate directions. |
| 2–3 s | “Too many places.” establishes the problem as the fragments separate in alignment and depth. |
| 3–4 s | Chat, code, and Shell briefly move in competing directions; a restrained pullback reveals the scattered composition. |
| 4–5 s | The fragments reverse and accelerate toward a shared alignment. One decisive lock leads into a supported, complete Gyro window. |
| 5–6 s | “Meet Gyro.” sits beside the window during a readable product reveal. |
| 6–7 s | The actual completed conversation and edited-file card dominate; `src/sync.js` remains readable. |
| 7–8 s | The real Review action introduces the matching native Review header and file. Surrounding content clears. |
| 8–9 s | Hold the real `Infinity` → `5` diff with its native red and green styling. |
| 9–10 s | A downward transition introduces the actual Shell panel and makes “2 passed, 2 total” the focal point. |
| 10–11 s | Pull back into the complete supported workspace, locating the evidence in the product. |
| 11–12 s | A smaller balanced window sits beside “One task. One workspace.” |
| 12–13 s | Coordinated motion clears the window and statement; the actual Gyro mark, “Gyro.” and “Coming soon.” resolve centrally. |
| 13–15 s | The closing image remains completely still while the original sound decays. |

The shared timeline specifies exact action cues within these editorial ranges. At 60 fps, the required final still occupies **frames 780–899 inclusive**: 120 frames, exactly two seconds. The entire film consists of 900 frames, with frame numbers starting at zero.

## Source and capture approach

The editable composition is in `scripts/gyro-reel-v06/`. Its current entry points are:

- `index.html`: browser composition document.
- `film.js`: stage, typography, layered compositions, and deterministic motion.
- `timeline.json`: duration, frame rate, dimensions, and shared cue times.
- `capture.mjs`: isolated development-harness capture of real Gyro UI regions and supported layouts.
- `render.mjs`: frame rendering and output orchestration.
- `sound.py`: deterministic original stereo synthesis using the same timing source.

Native component regions are captured directly from Gyro’s local development harness, preserving their internal geometry, typography, controls, syntax highlighting, and diff colours. These faithful regions may be translated, scaled, masked, and arranged editorially on the stage; their interiors are not recreated as invented product UI. The convergence and later pullback resolve to a supported full application layout.

The intended capture pipeline regenerates native UI assets at device-pixel ratio 4. The intended final composition render uses device-pixel ratio 2, followed by downsampling to 1920×1080. These are production settings, not a claim that final output validation has already passed.

All demo content belongs to one consistent existing session. Fixture state is development-only. This work does not require production API changes or new production component exports.

## Evidence, ownership, and claims

- Product visuals and the Gyro mark come from the local Gyro project supplied for this work. The film uses its actual app and brand assets.
- Display typography uses the native macOS system display font available in the capture environment. No external font file is downloaded, redistributed, or supplied in the editable package.
- The soundtrack is original NumPy synthesis with a fixed random seed: no external music, recordings, voice, or samples. `sound.py` retains the editable instrument and arrangement source.
- Supplied reference videos inform strategic pacing, hierarchy, and motion principles. They are not footage or audio sources for the composition.
- The conversation, code edit, diff, and passing test result are a staged presentation of an existing demo. Editorial timing is not a task-completion speed claim, performance benchmark, or claim that tests execute in the time between shots.
- “Coming soon.” is the only release-timing message. No date, version, or additional product capability is inferred.

## Review and delivery process

The first review package consists of four designed boards—opening, fragmentation/convergence, product proof, and ending—plus a timed rough animatic. Use this package to inspect composition, message clarity, focal-point order, and pacing before encoding the final deliverable. Any revisions should retain the shared deterministic timeline and genuine UI sources.

Final production then renders the full frame sequence, mixes the measured original stereo score, and encodes the deliverable. The final reviewer must verify native-source fidelity, settled text readability at a phone-preview scale, absence of clipping or empty frames during travel, actual interaction order, exact two-second still, duration, resolution, frame rate, stereo channels, loudness, and final codec peaks. Final output metadata and pass/fail results belong in the final QA report; they are not asserted here.

Audio loudness, clipping, duration, DC offset, stereo correlation, and end-sample checks can be performed numerically. **There is no tool-supported subjective headphone audition in this workflow.** Numerical audio results do not substitute for a listening review, and no completed subjective playback review is claimed.

The requested final specification is **15.000 seconds, 1920×1080, 60 fps, stereo**, accompanied by editable source and documented visual and audio checks. This document records production intent and provenance, not completion of the final render or its acceptance review.
