# Gyro v07 — sound direction and cue sheet

The revised score follows the longer camera arcs. Broad air and harmonic envelopes replace the former stream of short ticks. The convergence has a sustained build and a rounded, low landing with a long resonant tail. The Review action is the only small dry interface click. Readable proof holds remain quiet.

All sound is original, deterministic NumPy synthesis. There are no external recordings, samples, voice, or licensed music. Timing comes directly from `scripts/gyro-reel-v07/timeline.json`; synthesis seed is `70927`.

| Time | Sound and purpose |
|---|---|
| 0.00 / 0.40 | Two rounded low resonances support “One task.” without sharp high-frequency hits. |
| 0.58–1.63 | Soft air supports the growing selection. |
| 0.82–4.27 | Sustained harmonic field widens behind the independently moving UI fragments. Three long air trajectories establish their separate stereo positions. |
| 2.30 | Low, slow tonal weight under “Too many places.” |
| 3.35–5.75 | Two opposing streams fold toward the centre during the long convergence. A lower harmonic build rises underneath. |
| 5.28–7.98 | Broad resolved chord and low fundamental land around the 5.35 alignment, then decay across the product reveal. |
| 5.60–7.95 | Gentle travelling air connects the camera arc through the conversation and Review. |
| 6.70 | Quiet native Review click, aligned with the visible action. |
| 7.95–8.55 | No new accent during the readable diff hold. |
| 8.43–9.96 | Low, wide air follows the downward Shell movement. |
| 9.53 / 9.64 | Soft overlapping tones resolve on the passing result. |
| 9.89–12.19 | One broad pullback swell sustains the move to the full workspace. |
| 10.53 | Quiet rounded tone under the final statement; no tick on each word. |
| 11.61–12.81 | A gentle sweep supports the coordinated clear and brand reveal. |
| 12.00–15.00 | Restrained low signature with upper harmonic tail. “Coming soon.” adds no extra ping. No sound begins during the static 13–15 second hold; the existing tail fades to silence. |

## Rebuild

From the repository root:

```sh
python3 scripts/gyro-reel-v07/sound.py
node scripts/gyro-reel-v07/finish-audio.mjs
```

`score.wav` is the synthesis source; `score-final.wav` is the 24-bit delivery master. Both contain exactly 720,000 stereo frames at 48,000 Hz: 15.000 seconds.

Master processing: 4× oversampled gain and transparent peak limiting, resampled to 48 kHz. Delivery AAC must use `-c:a aac -aac_coder fast -b:a 256k -ar 48000 -ac 2`. The previous version exposed an initial-packet overshoot with the default `twoloop` coder; the specified coder has been measured after encode/decode here.

## Measured review

- PCM master: **−15.1 LUFS integrated, −2.4 dBTP**.
- Validation AAC, decoded: **−15.1 LUFS integrated, −2.4 dBTP**.
- Both: **15.000 seconds, stereo, 48 kHz**.
- Fade ends at digital silence; there are no new events in the two-second still hold.
- The synthesis and mastering scripts are editable and reproducible.

Machine verification covers duration, format, integrated loudness, true peak, and continuous cue timing. Subjective headphone audition was not performed; the measurements do not substitute for a listening review.
