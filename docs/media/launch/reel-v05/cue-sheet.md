# Gyro v05 sound cue sheet

**Source:** `scripts/gyro-reel-v05/sound.py` renders `score.wav`, 15.000 seconds, stereo, 48 kHz. All sound is original deterministic NumPy synthesis using oscillators and seeded, frequency-shaped noise. No external samples, recordings, licensed tracks or voice are present.

| Time (seconds) | Cue and purpose |
| --- | --- |
| 0.00–15.00 | Three overlapping suspended tonal fields provide a quiet continuous bed. |
| 0.08–1.98 | Air pans across the opening edge rotation. Rounded glass notes at 0.13 and 1.43 mark the reveal. |
| 2.03–2.83 | Directional air follows the composer push; a low soft pulse at 2.54 anchors the move. |
| 3.04–3.43 | Eight quiet tactile ticks accompany typing. |
| 3.55 | A soft click and short glass note mark Send. |
| 3.98–4.44 | Air accompanies the result reveal. The visual result appears at **4.10**; the glass response follows at **4.20**. |
| 5.02–5.56 | Air follows the file-to-Review move; selection tick at 5.20 and rounded tone at 5.26. |
| 5.95–6.62 | Broad directional air covers the **6.10–6.50** editor travel. Tactile action at 6.20, light tonal accent at 6.32; the editor opens at **6.416**. |
| 7.00 | Quiet upper glass note marks the changed-line focus. |
| 7.92–8.64 | Air follows the terminal sweep. A tick at 8.20 and soft low pulse at 8.25 support the panel reveal. |
| 9.00 / 9.08 | Two restrained tones accompany the passing-test result. |
| 9.52–10.94 | Lower, wider air follows the workspace pullback; a quiet glass accent lands at 10.10. |
| 11.00–12.05 | Air follows the edge collapse, with a soft low pulse at 11.68. |
| 11.96–12.48 | Directional air carries the brand sweep. |
| 12.20 / 12.31 / 12.47 | Low pulse and three spaced glass notes form the closing brand signature. |
| 13.00 | A light upper note supports “Coming soon.” |
| 14.00–15.00 | Global fade closes all remaining tails cleanly. |

## Finishing evidence

The source WAV measures −19.22 LUFS integrated and −3.10 dBTP. The two-pass normalization settings documented in the source README target −15 LUFS and −1.5 dBTP; measurement after that filter gave −14.90 LUFS and −1.50 dBTP before delivery encoding. Re-measure the encoded master for its final values.

Cue timing and waveform measurements were inspected programmatically. **Audio audition was not performed by the tools**, so this document does not claim a listening review.
