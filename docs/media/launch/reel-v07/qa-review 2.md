# Gyro v07 review notes

## Response to feedback

The user found v06 too snappy and wanted more dramatic motion. V07 retains 15 seconds and the two-second closing hold, while changing the motion system:

- Continuous outward travel into fragmentation, with the native surfaces entering at different depths and angles.
- Convergence expanded to roughly 1.7 seconds, with broad arcs and a controlled flattening into the real Gyro window.
- Native Review introduced during one continuous move, replacing v06's separate 0.33-second extra zoom.
- Downward Shell arrival spread across roughly 1.1 seconds.
- Workspace pullback extended to roughly 1.8 seconds, with the statement revealed as the window clears space.
- Original stereo sound recomposed around sustained swells, fewer impacts and longer resonant tails.

## Visual review

Representative frames and dense transition samples were inspected. Independent source review checked camera handoffs, uniform native scale and settled crop bounds. Hero-to-conversation shares the native (672,55) crop anchor; Shell-to-workspace derives its entire transform from (280,780). Cubic travel preserves velocity through intermediate keys. UI perspectives resolve flat at the proof holds.

Corrections from the motion review: remove translucent text overlap during the Review entrance; prevent the statement from colliding with the moving window; fade the editorial Shell crop and its shadow once the supported full workspace takes over; use the same focal motion blur on each crop/window pair; attach “Meet Gyro.” to the camera during the conversation push so it leaves with the reveal composition.

The conversation, diff and Shell have short crisp reading holds, supported by longer readable approaches. Complete windows provide context; tiny controls are not intended to be read at phone-preview size. Intentional offscreen entrances, departures and camera crops remain part of the travel.

## Fidelity and provenance

Native assets are unchanged copies of the verified v06 DPR4 captures, including typography, icons, code, diff colours, geometry and Shell output. Each source region was previously compared pixel-for-pixel against its preserved full app frame; `capture-manifest.json` retains those hashes and evidence. No production app code was changed for this revision. The supplied reference is not a footage or audio source.

## Audio and technical review

The soundtrack is original synthesis. The final PCM and decoded fast-AAC checks measure −15.1 LUFS and −2.4 dBTP; exact evidence is in `audio-final-check.log` and `cue-sheet.md`. The final MP4 passes verification: 15.000 seconds, 1920×1080, 60 fps, 900 frames, stereo 48 kHz AAC, −15.1 LUFS and −2.4 dBTP. All 120 decoded closing frames (13–15 seconds) are pixel-identical. The full media decodes successfully, with no unexpected black frames. Evidence is recorded in `verification.json`.

This is frame-based visual and numerical audio review. Subjective real-time listening through headphones is not supported by the available tools and is not claimed. The finished video is supplied for that playback review.
