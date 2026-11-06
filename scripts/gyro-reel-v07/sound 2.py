"""Gyro v07 — weight, continuity, and space.

Deterministic original stereo synthesis. No recordings, external samples, or
voice. The frame timeline is the single cue authority. Long evolving air and
harmonic envelopes support the camera arcs; only the visible Review action
gets a small dry click. All closing sounds begin before the static hold.
"""
from pathlib import Path
import json
import wave
import numpy as np

HERE = Path(__file__).resolve().parent
TIMELINE = json.loads((HERE / "timeline.json").read_text())
C = TIMELINE["cues"]
SR = 48000
D = float(TIMELINE["duration"])
RNG = np.random.default_rng(70927)
OUT = np.zeros((round(SR * D), 2), dtype=np.float64)


def axis(duration):
    return np.arange(round(duration * SR), dtype=np.float64) / SR


def place(start, signal, level=1., pan=0.):
    offset = round(start * SR)
    if offset < 0:
        signal = signal[-offset:]
        offset = 0
    count = min(len(signal), len(OUT) - offset)
    if count <= 0:
        return
    p = np.clip(np.broadcast_to(np.asarray(pan), len(signal))[:count], -.95, .95)
    OUT[offset:offset + count, 0] += signal[:count] * level * np.sqrt((1 - p) / 2)
    OUT[offset:offset + count, 1] += signal[:count] * level * np.sqrt((1 + p) / 2)


def band_noise(duration, low=90, high=1600):
    n = round(duration * SR)
    spec = np.fft.rfft(RNG.normal(size=n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= (1 - np.exp(-(f / low) ** 2)) * np.exp(-(f / high) ** 2)
    s = np.fft.irfft(spec, n=n)
    return s / max(np.sqrt(np.mean(s ** 2)), 1e-9)


def bell_env(t, duration, attack=.08, decay=2.1):
    return (1 - np.exp(-t / attack)) ** 2 * np.exp(-t * decay) * np.clip((duration - t) / .25, 0, 1)


def resonance(start, frequency, duration=1.8, level=.10, pan=0., attack=.055, decay=2.2):
    t = axis(duration)
    env = bell_env(t, duration, attack, decay)
    # Mildly inharmonic upper material gives shape without bright tick edges.
    s = np.sin(2 * np.pi * frequency * t)
    s += .20 * np.sin(2 * np.pi * frequency * 2.003 * t) * np.exp(-t * 1.8)
    s += .05 * np.sin(2 * np.pi * frequency * 3.011 * t) * np.exp(-t * 3)
    s *= env
    place(start, s, level, pan)
    place(start + .113, s, level * .15, -.65 * pan)
    place(start + .249, s, level * .07, .4 * pan)


def air(start, duration, level=.026, p0=-.65, p1=.65, high=1500, exponent=1.7):
    t = axis(duration)
    u = t / duration
    smooth = .5 - .5 * np.cos(np.pi * u)
    env = np.sin(np.pi * u) ** exponent
    # Slight slow modulation preserves movement without rhythmic ticks.
    env *= .88 + .12 * np.cos(2 * np.pi * (.22 * t + .08 * t * t))
    s = band_noise(duration, 120, high) * env
    p = p0 + (p1 - p0) * smooth
    place(start, s, level, p)
    place(start + .031, s, level * .18, -.75 * p)


def harmonic_arc(start, duration, pitches, level=.026, attack=.7, release=.85, width=.5):
    t = axis(duration)
    env = np.sin(np.pi / 2 * np.clip(t / attack, 0, 1)) ** 2
    env *= np.sin(np.pi / 2 * np.clip((duration - t) / release, 0, 1)) ** 2
    for i, freq in enumerate(pitches):
        p = width * (2 * i / max(len(pitches) - 1, 1) - 1)
        detune = .0010 * (i % 2 * 2 - 1)
        phase = 2 * np.pi * freq * t + .035 * np.sin(2 * np.pi * .19 * t)
        s = np.sin(phase) + .23 * np.sin(2 * np.pi * freq * (1 + detune) * t + .3)
        s += .035 * np.sin(phase * 2)
        place(start, s * env, level / (1 + i * .2), p)


def weight(start, duration=1.65, level=.11, frequency=46.249, attack=.1):
    t = axis(duration)
    env = bell_env(t, duration, attack, 1.9)
    s = np.sin(2 * np.pi * frequency * t)
    s += .45 * np.sin(2 * np.pi * frequency * 2 * t)
    s += .11 * np.sin(2 * np.pi * frequency * 3 * t)
    place(start, s * env, level, 0)


def click(start, level=.013):
    t = axis(.16)
    s = .6 * band_noise(.16, 430, 3000) + .4 * np.sin(2 * np.pi * 740 * t)
    env = (1 - np.exp(-t * 600)) * np.exp(-t * 52) * np.clip((.16 - t) / .02, 0, 1)
    place(start, s * env, level, .12)


# Two deliberate opening beats, rounded into resonances rather than hard hits.
weight(C["one"], 1.7, .145, attack=.025)
resonance(C["one"], 184.997, 1.7, .16, -.12, .024, 2.4)
resonance(C["task"], 277.183, 2.0, .16, .12, .04, 1.9)
air(C["selection"] - .24, 1.05, .016, -.20, .25, 1700)

# One continuous widening field bridges all three independently moving parts.
# Distinct stereo trajectories replace the former fragment-by-fragment clicks.
harmonic_arc(.82, 3.45, [92.499, 184.997, 277.183], .020, .9, 1.0, .64)
air(C["taskFragment"] - .45, 1.85, .025, -.12, -.76, 1400)
air(C["codeFragment"] - .42, 1.90, .021, .12, .73, 2050)
air(C["shellFragment"] - .38, 1.85, .023, .40, -.25, 1150)
# The problem statement adds mass, not another snare-like marker.
resonance(C["places"], 164.814, 1.85, .065, -.10, .17, 1.8)

# Long convergence build: stereo air folds inward, low body grows beneath it,
# then a broad resolved chord opens at the actual alignment. No sharp impact.
span = C["lock"] - C["converge"]
air(C["converge"] - .30, span + .70, .054, -.83, .0, 1300, 1.3)
air(C["converge"] - .12, span + .53, .047, .84, .0, 2300, 1.5)
harmonic_arc(C["converge"], span + .38, [69.296, 138.591, 277.183], .040, span * .88, .26, .48)
weight(C["lock"] - .065, 2.30, .23, attack=.080)
resonance(C["lock"] - .07, 184.997, 2.7, .19, -.13, .11, 1.35)
resonance(C["lock"], 369.994, 2.6, .10, .18, .16, 1.45)
harmonic_arc(C["lock"] - .06, 2.35, [92.499, 277.183, 554.365], .015, .25, 1.7, .50)

# The camera continues its arc through authentic UI. A single click belongs to
# the visible Review interaction; no accent is added when the diff settles.
air(C["conversation"], C["reviewHold"] - C["conversation"], .021, -.32, .35, 1750, 1.5)
click(C["reviewClick"])
harmonic_arc(C["review"] - .10, 1.65, [184.997, 369.994], .018, .55, .9, .4)

# Downward travel is a full soft sweep. The passing result receives a quiet
# musical resolution instead of the old two quick confirmation pings.
air(C["terminal"] - .12, C["terminalHold"] - C["terminal"] + .48,
    .034, .27, -.32, 1300, 1.5)
resonance(C["terminalHold"] - .07, 277.183, 1.60, .075, -.14, .10, 2.0)
resonance(C["terminalHold"] + .04, 369.994, 1.6, .042, .17, .16, 1.9)

# Broad pullback and sustained statement. The air widens while the bass and
# upper harmonic remain connected, making scale change feel heavy and slow.
air(C["pullback"] - .06, C["clear"] - C["pullback"] + .38,
    .030, -.2, .5, 1250, 1.25)
harmonic_arc(C["pullback"], 2.30, [92.499, 184.997, 369.994], .026, .66, .94, .56)
resonance(C["statement"] - .12, 277.183, 1.85, .049, .1, .18, 1.5)

# Final coordinated motion resolves into a restrained, long signature.
air(C["clear"] - .14, 1.20, .025, -.44, .38, 1800, 1.3)
weight(C["brand"], 2.6, .106, attack=.14)
resonance(C["brand"], 184.997, D - C["brand"], .113, -.13, .13, 1.05)
resonance(C["brand"] + .09, 369.994, D - C["brand"] - .09, .073, .17, .18, 1.08)
harmonic_arc(C["brand"] + .16, D - C["brand"] - .16,
    [277.183, 554.365], .016, .54, 1.8, .52)
# Coming soon stays quiet. No new sound starts in the 13–15 s still hold.

# Remove DC, retain headroom, and fade to exact digital silence at both ends.
t = axis(D)
fade = np.clip(t / .005, 0, 1)
fade *= np.clip((D - t) / 1.7, 0, 1) ** 1.5
OUT -= np.mean(OUT, axis=0, keepdims=True)
OUT *= fade[:, None]
OUT *= .74 / max(float(np.max(np.abs(OUT))), 1e-9)
OUT[0] = 0
OUT[-1] = 0
DEST = HERE.parents[1] / "docs/media/launch/reel-v07/score.wav"
DEST.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(DEST), "wb") as writer:
    writer.setnchannels(2)
    writer.setsampwidth(2)
    writer.setframerate(SR)
    writer.writeframes(np.clip(OUT * 32767, -32768, 32767).astype("<i2").tobytes())
print(DEST)
