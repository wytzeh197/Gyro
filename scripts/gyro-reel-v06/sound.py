"""Gyro v06 — One task. One workspace.

Original deterministic stereo synthesis; no recordings, voice, or samples.
The shared frame timeline is the timing authority. Small dry strikes establish
an opening motif, divergent panning creates friction, and a single resolved
chord marks convergence. Readable UI holds deliberately have less sound.
"""
from pathlib import Path
import json
import wave

import numpy as np

HERE = Path(__file__).resolve().parent
TIMELINE = json.loads((HERE / "timeline.json").read_text())
CUE = TIMELINE["cues"]
SR = 48000
DURATION = float(TIMELINE["duration"])
RNG = np.random.default_rng(60927)
OUT = np.zeros((round(SR * DURATION), 2), dtype=np.float64)


def axis(duration):
    return np.arange(round(duration * SR), dtype=np.float64) / SR


def place(start, signal, level=1.0, pan=0.0):
    """Equal-power stereo panning; arrays allow continuous spatial motion."""
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


def noise(duration, low=250, high=3800):
    count = round(duration * SR)
    spectrum = np.fft.rfft(RNG.normal(size=count))
    f = np.fft.rfftfreq(count, 1 / SR)
    band = (1 - np.exp(-(f / low) ** 2)) * np.exp(-(f / high) ** 2)
    signal = np.fft.irfft(spectrum * band, n=count)
    return signal / max(np.sqrt(np.mean(signal ** 2)), 1e-9)


def strike(start, frequency=440, level=.05, pan=0.0, duration=.36, body=.45):
    """Dry, softly rounded ceramic strike rather than a sharp digital click."""
    t = axis(duration)
    env = (1 - np.exp(-t * 600)) * np.exp(-t * 26)
    env *= np.minimum((duration - t) / .015, 1)
    tone = np.sin(2 * np.pi * frequency * t) + .14 * np.sin(2 * np.pi * frequency * 2.71 * t)
    grain = noise(duration, 420, 4200) * np.exp(-t * 65)
    place(start, (tone * body + grain * (1 - body)) * env, level, pan)


def low_note(start, frequency=92.499, level=.11, duration=.85, pan=0):
    """Short warm fundamental, without a dance-kick pitch envelope."""
    t = axis(duration)
    env = (1 - np.exp(-t * 105)) * np.exp(-t * 5.8)
    env *= np.clip((duration - t) / .11, 0, 1)
    signal = np.sin(2 * np.pi * frequency * t)
    signal += .19 * np.sin(2 * np.pi * frequency * 2 * t)
    signal += .065 * np.sin(2 * np.pi * frequency * 3 * t)
    place(start, signal * env, level, pan)


def pluck(start, frequency, level=.085, pan=0, duration=1.2, decay=4.5, echo=True):
    t = axis(duration)
    env = (1 - np.exp(-t * 280)) * np.exp(-t * decay)
    env *= np.clip((duration - t) / .13, 0, 1)
    signal = np.sin(2 * np.pi * frequency * t)
    signal += .16 * np.sin(2 * np.pi * frequency * 2 * t) * np.exp(-t * 6)
    signal += .032 * np.sin(2 * np.pi * frequency * 3.002 * t) * np.exp(-t * 12)
    signal *= env
    place(start, signal, level, pan)
    if echo:
        place(start + .128, signal, level * .115, -.7 * pan)
        place(start + .271, signal, level * .045, .6 * pan)


def sweep(start, duration, level=.033, pan_from=-.6, pan_to=.6,
          low=280, high=2500, bias=0):
    t = axis(duration)
    u = t / duration
    # A late-peaking curve can draw attention toward a landing instead of away.
    envelope = np.sin(np.pi * u) ** 2.3 * (1 + bias * (u - .5))
    travel = u * u * (3 - 2 * u)
    p = pan_from + (pan_to - pan_from) * travel
    signal = noise(duration, low, high) * envelope
    place(start, signal, level, p)
    place(start + .018, signal, level * .10, -.7 * p)


def bloom(start, duration, frequencies, level=.008):
    """Very quiet spectral space only beneath the two important resolutions."""
    t = axis(duration)
    env = (1 - np.exp(-t * 13)) * np.exp(-t * .95)
    env *= np.clip((duration - t) / .5, 0, 1)
    for i, frequency in enumerate(frequencies):
        signal = np.sin(2 * np.pi * frequency * t + .018 * np.sin(2 * np.pi * .23 * t))
        signal += .16 * np.sin(2 * np.pi * frequency * 1.0015 * t + .17)
        place(start, signal * env, level, (i - (len(frequencies) - 1) / 2) * .3)


# One / task: a recognisable two-strike motif with an understated F-sharp body.
strike(CUE["one"], 554.365, .095, -.1, body=.6)
low_note(CUE["one"], 92.499, .125)
pluck(CUE["one"], 184.997, .058, -.1, .6, 8, False)
strike(CUE["task"], 739.989, .105, .1, body=.58)
low_note(CUE["task"], 138.591, .086, .6)
pluck(CUE["task"], 277.183, .063, .1, .75, 7, False)
sweep(CUE["selection"] - .11, .30, .022, -.12, .14, high=3300)
strike(CUE["selection"], 1108.731, .027, .08, .16, .5)

# The same tonal family splits into three spatially separate native UI pieces.
fragment_events = [
    ("taskFragment", 369.994, -.63, -.23),
    ("codeFragment", 554.365, .57, .18),
    ("shellFragment", 277.183, .18, .65),
]
for name, frequency, p0, p1 in fragment_events:
    start = CUE[name]
    sweep(start - .18, .43, .026, p0, p1, high=2100)
    pluck(start, frequency, .073, p0, .85, 6)
    strike(start, frequency * 2, .025, p0, .20)

# Statement then competing motion. Unequal accents, each with its own location,
# create unease through rhythm and space without adding dissonant alarm sounds.
low_note(CUE["places"], 82.407, .070, .65)
strike(CUE["places"], 493.883, .060, -.12)
pluck(CUE["places"], 246.942, .045, -.08, .7, 7)
for delta, frequency, pan, level in [
    (0.00, 554.365, -.57, .037),
    (.24, 493.883, .51, .032),
    (.55, 369.994, -.31, .046),
    (.73, 554.365, .63, .036),
    (1.02, 493.883, -.65, .025),
]:
    start = CUE["scatter"] + delta
    strike(start, frequency, level, pan, .22)
    sweep(start - .07, .30, .012, pan * .35, pan, high=1500)
low_note(CUE["scatter"] + .55, 82.407, .041, .6, -.08)

# Convergence: two opposing air streams narrow into one dry, clear centre hit.
converge_span = CUE["lock"] - CUE["converge"]
sweep(CUE["converge"], converge_span, .038, -.76, 0, high=1850, bias=.9)
sweep(CUE["converge"] + .075, converge_span - .075, .033, .76, 0, high=2600, bias=.9)
pluck(CUE["lock"] - .115, 277.183, .020, -.1, .4, 9, False)
strike(CUE["lock"], 739.989, .105, 0, body=.7)
low_note(CUE["lock"], 92.499, .162, 1.10)
pluck(CUE["lock"], 369.994, .115, -.13, 1.50, 3.9)
pluck(CUE["lock"] + .035, 554.365, .052, .19, 1.4, 4.3)
bloom(CUE["lock"], 1.3, [184.997, 277.183, 369.994], .006)
# The nearby Meet cue shares the resolved chord; an extra loud hit would clutter.

# Native evidence: tactile interface cues and short musical replies, with space.
sweep(CUE["conversation"] - .19, .49, .027, -.24, .26, high=1900)
pluck(CUE["conversation"], 277.183, .074, -.14, .92, 5.1)
strike(CUE["conversation"] + .025, 554.365, .028, -.14)
strike(CUE["reviewClick"], 980, .044, .11, .18, .3)
sweep(CUE["review"] - .06, .46, .028, .35, -.12, high=2150)
pluck(CUE["review"] + .035, 369.994, .072, .12, 1.0, 4.8)
pluck(CUE["reviewHold"], 554.365, .033, -.12, .85, 5.9)

# Downward shell reveal, followed by a concise two-note confirmation.
sweep(CUE["terminal"], CUE["terminalHold"] - CUE["terminal"],
      .035, .20, -.27, low=240, high=1700, bias=.6)
strike(CUE["terminal"] + .03, 700, .018, .05, .19, .35)
low_note(CUE["terminalHold"], 92.499, .078, .9)
pluck(CUE["terminalHold"], 369.994, .078, -.14, 1.05, 4.5)
pluck(CUE["terminalHold"] + .10, 554.365, .044, .15, 1.0, 4.8)

# A broad pullback relaxes the image. The original two-strike idea resolves into
# a spacious single statement, then the same coordinated movement clears it.
sweep(CUE["pullback"], .90, .020, -.35, .25, low=190, high=1450)
pluck(CUE["pullback"] + .13, 277.183, .033, .18, 1.10, 4.4)
low_note(CUE["statement"], 138.591, .092, .88)
strike(CUE["statement"], 739.989, .042, 0, .30, .6)
pluck(CUE["statement"], 554.365, .071, -.08, 1.1, 4.4)
sweep(CUE["clear"], .52, .035, -.46, .46, high=2400, bias=.5)

# A restrained signature; no new transients during the exact closing hold.
low_note(CUE["brand"], 92.499, .107, 1.15)
pluck(CUE["brand"], 369.994, .098, -.16, 2.60, 2.4)
pluck(CUE["brand"] + .04, 554.365, .042, .17, 2.55, 2.6)
bloom(CUE["brand"], DURATION - CUE["brand"], [184.997, 277.183, 369.994], .0065)
pluck(CUE["soon"], 739.989, .028, .10, 2.25, 3.2)

# A short de-click at the first sample and a long, clean closing fade.
t = axis(DURATION)
fade = np.clip(t / .0025, 0, 1)
fade *= np.clip((DURATION - t) / 1.15, 0, 1) ** 1.7
OUT *= fade[:, None]
OUT -= np.mean(OUT, axis=0, keepdims=True) * fade[:, None]
OUT *= .74 / max(float(np.max(np.abs(OUT))), 1e-9)
OUT[0] = 0
OUT[-1] = 0

destination = HERE.parents[1] / "docs/media/launch/reel-v06/score.wav"
destination.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(destination), "wb") as writer:
    writer.setnchannels(2)
    writer.setsampwidth(2)
    writer.setframerate(SR)
    writer.writeframes(np.clip(OUT * 32767, -32768, 32767).astype("<i2").tobytes())
print(destination)
