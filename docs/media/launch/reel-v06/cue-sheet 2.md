# Gyro v06 original soundtrack

15.000 seconds · stereo · 48,000 Hz. The editable source mix is 16-bit PCM; the delivery mix is 24-bit PCM. All sound is synthesized in `scripts/gyro-reel-v06/sound.py` using NumPy with a fixed random seed. No samples, recordings, voice, or third-party music are used. The script reads `scripts/gyro-reel-v06/timeline.json`; its cues share the video timeline.

## Cue map

| Time | Sound and purpose |
|---|---|
| 0.00 / 0.35 | Two rounded ceramic strikes and short warm notes establish “One / task.” The motif has a precise attack without a harsh digital spike. |
| 0.72 | A compact brushed sweep traces the blue selection. |
| 1.15 / 1.40 / 1.65 | Three pitched fragments occupy left, right, and lower-centre stereo positions. Each has its own short moving air gesture. |
| 2.20 | A subdued lower response supports “Too many places.” |
| 2.80–4.05 | Unequal, alternating spatial strikes suggest competing motion. There is no continuous drum loop. |
| 4.05–4.92 | Opposing filtered-air streams narrow toward the centre. |
| 4.92 / 5.00 | One clear lock impact resolves into a soft F-sharp chord. “Meet Gyro” inherits this sound instead of adding a second impact. |
| 6.00 | A short pan and muted pluck introduce the actual completed conversation. |
| 7.15 / 7.20 | A tactile Review click precedes a compact transition sweep and soft note. |
| 7.80–8.90 | A very quiet note decays into space so the diff has a readable hold. |
| 9.00–9.55 | A lower, darker sweep follows the Shell panel downward. |
| 9.55 / 9.65 | A concise two-note answer supports the passing-test result. |
| 10.05–10.95 | Broad, quiet air accompanies the pullback. |
| 11.00 | The opening motif resolves into a single spacious statement. |
| 12.00 | One coordinated sweep clears the app and statement. |
| 12.35 / 12.65 | A restrained tonal signature supports the Gyro mark; a quieter upper note supports “Coming soon.” |
| 13.00–15.00 | No new attacks. Existing tones decay; the final 1.15 seconds fade smoothly to zero. |

## Rebuild and final encode

From the repository root:

```sh
python3 scripts/gyro-reel-v06/sound.py
node scripts/gyro-reel-v06/finish-audio.mjs
```

Keep `score.wav` as the original editable mix. `finish-audio.mjs` creates the separate delivery master, **`score-final.wav`**, and checks both the PCM and a temporary encoded-and-decoded AAC. It applies this fixed filter to the original mix:

```text
aresample=192000,volume=4.4dB,alimiter=limit=0.76:attack=5:release=60:level=false:latency=true,aresample=48000,atrim=start=0:end=15,afade=t=in:st=0:d=0.001,afade=t=out:st=14.99:d=0.01
```

The limiter works at 192 kHz with latency compensation and disabled automatic gain. Its 0.76 ceiling leaves headroom for the delivery codec. A 1 ms initial de-click and final 10 ms fade ensure clean PCM boundaries without moving the cues.

**Use `score-final.wav` directly when muxing the video. Do not apply the previous inline loudnorm filter or any further volume boost.** Encode using these exact AAC options:

```text
-c:a aac -aac_coder fast -b:a 256k -ar 48000 -ac 2
```

The FFmpeg build’s default AAC coder produced a large first-packet overshoot on this particular transient-led soundtrack: the earlier video decoded to +2.8 dBTP near 12.7 ms despite a safe PCM measurement. The same issue reproduced when encoding the separately limited PCM with the default coder. The explicit `fast` AAC coder avoids that observed overshoot on this score and was verified after decoding. The old `loudness-pass1.log` is retained as a historical source measurement only; it is not delivery validation.

## Numerical review

- Source length: exactly 720,000 stereo sample frames, 15.000 seconds at 48,000 Hz.
- Source integrated loudness: **−18.80 LUFS**; true peak: **−2.61 dBTP**; loudness range: **4.60 LU**.
- Final PCM master: exactly 720,000 stereo sample frames, 15.000 seconds, 48,000 Hz, signed 24-bit PCM.
- Final PCM measurement: **−15.2 LUFS**, **−2.4 dBTP**.
- Decoded AAC validation using the explicit settings above: **−15.2 LUFS**, **−2.4 dBTP**. The MP4/M4A stream duration is exactly 15.000 seconds.
- The final mastering script rejects results above **−1.5 dBTP** or outside **−15 ± 0.6 LUFS**, and checks sample rate, stereo channels, and duration.
- Source channel correlation: 0.979. Stereo movement is restrained. Source DC offsets are below 0.000001.
- The source’s first and final samples are zero; the mastered PCM also receives explicit short boundary fades. The last 100 ms of the source is silent after 16-bit quantization.
- Loudness and wave-shape checks were performed numerically. No subjective playback or human listening review is claimed. The actual muxed final MP4 should receive one final decoded-audio measurement using the same settings.

Current evidence is stored in `audio-final-check.log`, `audio-final-check-pcm.log`, and `audio-final-check-aac.log`.
