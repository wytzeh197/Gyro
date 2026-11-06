"""Original Gyro v04 score: soft felt/glass, warm pulse, restrained movement.

All sound is synthesized here; there are no external recordings or samples.
The rendered stereo source is normalized during the final video encode.
"""
from pathlib import Path
import wave

import numpy as np

SR = 48000
DURATION = 15.0
RNG = np.random.default_rng(40927)
OUT = np.zeros((round(SR * DURATION), 2), dtype=np.float64)


def axis(duration):
    return np.arange(round(SR * duration), dtype=np.float64) / SR


def add(start, signal, level=1.0, pan=0.0):
    index = round(start * SR)
    if index < 0:
        signal = signal[-index:]
        index = 0
    count = min(len(signal), len(OUT) - index)
    if count <= 0:
        return
    OUT[index:index + count, 0] += signal[:count] * level * np.sqrt((1 - pan) / 2)
    OUT[index:index + count, 1] += signal[:count] * level * np.sqrt((1 + pan) / 2)


def pluck(frequency, duration=2.4, softness=1.0):
    """Rounded transient with a light glass harmonic and natural short decay."""
    t = axis(duration)
    attack = 1 - np.exp(-t * 75)
    body = np.sin(2 * np.pi * frequency * t) * np.exp(-t * 2.8 * softness)
    body += .22 * np.sin(2 * np.pi * frequency * 2.002 * t) * np.exp(-t * 5.8)
    body += .052 * np.sin(2 * np.pi * frequency * 3.997 * t) * np.exp(-t * 8.4)
    return body * attack * np.minimum((duration - t) / .08, 1)


def struck(start, frequency, level=.15, pan=0.0, duration=2.4):
    signal = pluck(frequency, duration)
    add(start, signal, level, pan)
    # Wide, very quiet reflections rather than rhythmic delay repeats.
    add(start + .137, signal, level * .17, -pan * .9)
    add(start + .293, signal, level * .085, pan * .55)


def pad(start, duration, frequencies, level):
    t = axis(duration)
    envelope = np.sin(np.pi * np.clip(t / duration, 0, 1)) ** 1.3
    for j, frequency in enumerate(frequencies):
        # Each tone changes slowly without sounding like a synth lead.
        signal = np.sin(2 * np.pi * frequency * t + .035 * np.sin(2 * np.pi * .19 * t))
        signal += .28 * np.sin(2 * np.pi * frequency * 1.0017 * t + .4)
        signal += .035 * np.sin(2 * np.pi * frequency * 2 * t)
        add(start, signal * envelope, level, (j - (len(frequencies) - 1) / 2) * .43)


def warm_pulse(start, frequency=73.416, level=.11):
    t = axis(1.5)
    envelope = (1 - np.exp(-t * 45)) * np.exp(-t * 5.8)
    signal = np.sin(2 * np.pi * frequency * t) + .12 * np.sin(2 * np.pi * frequency * 2 * t)
    add(start, signal * envelope, level)


def movement(end, duration=.5, level=.072, direction=1):
    """A short airy gesture, frequency-shaped and free from a sharp hiss."""
    t = axis(duration)
    noise = RNG.normal(0, 1, len(t))
    spectrum = np.fft.rfft(noise)
    freq = np.fft.rfftfreq(len(t), 1 / SR)
    shape = (1 - np.exp(-(freq / 380) ** 2)) * np.exp(-(freq / 2450) ** 2)
    shaped = np.fft.irfft(spectrum * shape, n=len(t))
    shaped /= max(np.sqrt(np.mean(shaped ** 2)), 1e-9)
    envelope = np.sin(np.pi * t / duration) ** 2.5
    signal = shaped * envelope
    add(end - duration * .8, signal, level, -.42 * direction)
    add(end - duration * .8 + .024, signal, level * .63, .52 * direction)


# Open D major / suspended harmony: bright but quiet, almost a room tone.
pad(0, 5.7, [146.832, 220.0, 329.628], .024)
pad(4.0, 6.9, [146.832, 246.942, 369.994], .024)
pad(9.1, 5.9, [146.832, 220.0, 293.665, 329.628], .022)

# Main notes follow the image events, with enough silence to preserve restraint.
for cue, frequency, level, pan in [
    (.03, 293.665, .185, -.08),       # Meet Gyro
    (1.35, 440.0, .145, .20),        # Provider constellation
    (2.16, 659.255, .074, -.32),     # Small distant answer
    (3.62, 369.994, .103, .25),      # Gathering begins
    (4.05, 293.665, .167, -.10),     # Composer lands
    (5.95, 440.0, .154, .12),        # Terminal
    (7.72, 369.994, .158, -.14),     # Workspace
    (9.80, 329.628, .167, .12),      # All in one
]:
    struck(cue, frequency, level, pan)

# A soft pulse anchors the cuts; no kick, snare, hats, or repeating beat.
for cue, frequency, level in [
    (0, 73.416, .16), (4.05, 73.416, .13), (5.95, 82.407, .11),
    (7.72, 92.499, .11), (9.80, 73.416, .14), (12.08, 73.416, .17),
]:
    warm_pulse(cue, frequency, level)

# Brief directional movements leave the typography room to breathe.
for cue, duration, level, direction in [
    (1.35, .38, .028, 1), (4.05, .63, .064, 1),
    (5.95, .40, .045, -1), (7.72, .43, .045, 1),
    (9.80, .58, .055, -1), (12.08, .68, .052, 1),
]:
    movement(cue, duration, level, direction)

# Brand signature: one clean resolving gesture, then a spacious tail.
struck(12.08, 293.665, .18, -.2, 2.8)
struck(12.19, 440.0, .105, .18, 2.7)
struck(12.33, 587.330, .083, -.05, 2.5)

t = axis(DURATION)
fade = np.minimum(t / .025, 1) * np.minimum((DURATION - t) / 1.0, 1) ** 1.5
OUT *= fade[:, None]
OUT *= .72 / max(float(np.max(np.abs(OUT))), 1e-9)

destination = Path(__file__).resolve().parents[2] / 'docs/media/launch/reel-v04/score.wav'
destination.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(destination), 'wb') as writer:
    writer.setnchannels(2)
    writer.setsampwidth(2)
    writer.setframerate(SR)
    writer.writeframes(np.clip(OUT * 32767, -32768, 32767).astype('<i2').tobytes())
print(destination)
