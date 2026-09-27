"""Gyro v05 — original, deterministic soundtrack for the continuous UI journey.

15 seconds / stereo / 48 kHz. NumPy synthesis only: no samples or recordings.
Music is a sparse suspended-D tonal field; camera motion has directional air,
UI actions use quiet tactile ticks. Final video encode applies measured loudnorm.
"""
from pathlib import Path
import wave

import numpy as np

SR = 48000
DURATION = 15.0
RNG = np.random.default_rng(50927)
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
    p = np.broadcast_to(np.asarray(pan), len(signal))[:count]
    OUT[index:index + count, 0] += signal[:count] * level * np.sqrt((1 - p) / 2)
    OUT[index:index + count, 1] += signal[:count] * level * np.sqrt((1 + p) / 2)


def glass(start, frequency, level=.1, pan=0.0, duration=2.4):
    t = axis(duration)
    attack = 1 - np.exp(-t * 95)
    signal = np.sin(2 * np.pi * frequency * t) * np.exp(-t * 2.7)
    signal += .17 * np.sin(2 * np.pi * frequency * 2.003 * t) * np.exp(-t * 5.6)
    signal += .035 * np.sin(2 * np.pi * frequency * 3.99 * t) * np.exp(-t * 8)
    signal *= attack * np.clip((duration - t) / .12, 0, 1)
    add(start, signal, level, pan)
    add(start + .113, signal, level * .18, -.7 * pan)
    add(start + .277, signal, level * .08, .8 * pan)


def field(start, duration, frequencies, level):
    t = axis(duration)
    envelope = np.sin(np.pi * t / duration) ** 1.35
    for i, frequency in enumerate(frequencies):
        signal = np.sin(2 * np.pi * frequency * t + .035 * np.sin(2 * np.pi * .16 * t))
        signal += .22 * np.sin(2 * np.pi * frequency * 1.0011 * t + .4)
        signal += .025 * np.sin(2 * np.pi * frequency * 2 * t)
        add(start, signal * envelope, level, (i - (len(frequencies) - 1) / 2) * .34)


def pulse(start, frequency=73.416, level=.075):
    t = axis(1.6)
    envelope = (1 - np.exp(-t * 35)) * np.exp(-t * 5.2)
    signal = np.sin(2 * np.pi * frequency * t) + .10 * np.sin(2 * np.pi * frequency * 2 * t)
    add(start, signal * envelope, level)


def filtered_noise(duration, lo=350, hi=2800):
    t = axis(duration)
    spectrum = np.fft.rfft(RNG.normal(size=len(t)))
    frequencies = np.fft.rfftfreq(len(t), 1 / SR)
    shape = (1 - np.exp(-(frequencies / lo) ** 2)) * np.exp(-(frequencies / hi) ** 2)
    signal = np.fft.irfft(spectrum * shape, n=len(t))
    return signal / max(np.sqrt(np.mean(signal ** 2)), 1e-9)


def air(start, duration, level, direction=1, high=2200):
    """Continuous equal-power pan follows the camera, with a soft reflected tail."""
    t = axis(duration)
    u = t / duration
    envelope = np.sin(np.pi * u) ** 2.2
    signal = filtered_noise(duration, 280, high) * envelope
    pan = direction * .58 * np.sin(np.pi * (u - .5))
    add(start, signal, level, pan)
    add(start + .023, signal, level * .18, -pan)


def tick(start, level=.018, pan=0.0, frequency=850):
    t = axis(.06)
    envelope = (1 - np.exp(-t * 1600)) * np.exp(-t * 120)
    signal = .65 * filtered_noise(.06, 600, 4500) + .35 * np.sin(2 * np.pi * frequency * t)
    add(start, signal * envelope, level, pan)


# Spatial atmosphere, deliberately quiet enough to hear the UI gestures.
field(0, 5.8, [146.832, 220.0, 329.628], .022)
field(3.8, 6.7, [146.832, 246.942, 369.994], .021)
field(8.3, 6.7, [146.832, 220.0, 293.665, 329.628], .022)

# Opening thin edge, app reveal, composer push.
air(.08, 1.90, .013, 1, 1800)
glass(.13, 293.665, .106, -.12)
glass(1.43, 440.0, .065, .18)
air(2.03, .80, .034, 1)
pulse(2.54, level=.06)

# Quick, tactile type cadence, then the single send action.
for i, start in enumerate([3.04, 3.095, 3.14, 3.20, 3.255, 3.31, 3.36, 3.43]):
    tick(start, .013 if i % 3 else .017, -.10 + i * .025, 730 + i * 43)
tick(3.55, .044, .17, 1200)
glass(3.55, 369.994, .06, .12, 1.7)

# Results, file review, editor and native line highlight; no notification melody.
air(3.98, .46, .023, -1)
glass(4.20, 440.0, .09, -.16)
tick(5.20, .030, -.1, 940)
air(5.02, .54, .038, 1)
glass(5.26, 329.628, .065, .10)
tick(6.20, .029, .12, 1060)
air(5.95, .67, .042, 1)
glass(6.32, 493.883, .053, .23)
glass(7.00, 587.330, .049, -.06, 1.6)

# Downward terminal move and passing tests: subtle two-tone confirmation.
air(7.92, .72, .038, -1, 1900)
tick(8.20, .024, -.08, 780)
pulse(8.25, 82.407, .067)
glass(9.00, 440.0, .084, -.13)
glass(9.08, 587.330, .046, .15, 1.8)

# Broad pullback flows into the edge collapse; less sound as the field clears.
air(9.52, 1.42, .026, -1, 1500)
glass(10.10, 329.628, .069, .12)
air(11.00, 1.05, .036, 1, 2200)
pulse(11.68, 73.416, .062)

# Brand sweep, restrained signature and a spacious two-second closing hold.
air(11.96, .52, .042, 1, 2600)
pulse(12.20, 73.416, .10)
glass(12.20, 293.665, .135, -.18, 2.75)
glass(12.31, 440.0, .074, .18, 2.6)
glass(12.47, 587.330, .060, -.02, 2.4)
glass(13.00, 659.255, .035, .14, 1.95)

t = axis(DURATION)
fade = np.clip(t / .025, 0, 1) * np.clip((DURATION - t) / 1.0, 0, 1) ** 1.6
OUT *= fade[:, None]
OUT *= .70 / max(float(np.max(np.abs(OUT))), 1e-9)

destination = Path(__file__).resolve().parents[2] / 'docs/media/launch/reel-v05/score.wav'
destination.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(destination), 'wb') as writer:
    writer.setnchannels(2)
    writer.setsampwidth(2)
    writer.setframerate(SR)
    writer.writeframes(np.clip(OUT * 32767, -32768, 32767).astype('<i2').tobytes())
print(destination)
