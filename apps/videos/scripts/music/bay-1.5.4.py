"""The score for "What's new in Bay 1.5.4": a warm lo-fi groove, synthesized here from scratch (no samples).

85.714 BPM, so a bar is 2.8 s: exactly the intro card (84 thirtieths of a second), and the film's 44.73 s is 16 bars.
Bar 1 is the intro (electric piano and pad alone), the groove runs under the recordings, the melody comes in for
the middle stretch, and the last bar is a Cmaj9 that rings out under the end card. A soft swell rises into every
scene change (SCENES, in thirtieths, as src/bay-1.5.4/index.tsx has them).

Voices: an FM electric piano (Rhodes-like tine), a detuned-saw pad, a sine sub bass, a kick, rim-snare and swung hats,
an FM bell for the melody, vinyl crackle; a generated stereo hall, a kick sidechain and a soft-clipping master.

usage: python3 scripts/music/bay-1.5.4.py   (needs numpy and scipy; writes public/music/bay-1.5.4.raw.wav, then
       ffmpeg's loudnorm makes public/music/bay-1.5.4.wav at -16 LUFS, -1.5 dBTP)
"""

import os
import subprocess
import wave

import numpy as np
from scipy import signal

SR = 48000
BPM = 600 / 7  # 85.714…: a beat is 0.7 s
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
LENGTH = 44.733 + 0.6
SCENES = [84, 270, 426, 554, 726, 822, 980, 1092, 1242]  # scene starts after the intro, in thirtieths

N = int(LENGTH * SR)
rng = np.random.default_rng(154)
here = os.path.dirname(os.path.abspath(__file__))
out_dir = os.path.join(here, "..", "..", "public", "music")


def midi(note):
    names = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
    name, octave = note[:-1], int(note[-1])
    return 12 * (octave + 1) + names[name]


def hz(note):
    return 440.0 * 2 ** ((midi(note) - 69) / 12)


def at(beats):
    """Sample index of a time in beats from the start."""
    return int(round(beats * BEAT * SR))


class Bus:
    def __init__(self):
        self.l = np.zeros(N)
        self.r = np.zeros(N)

    def add(self, start, mono, pan=0.0, gain=1.0):
        if start >= N:
            return
        mono = mono[: N - start] * gain
        self.l[start : start + len(mono)] += mono * np.sqrt(0.5 * (1 - pan))
        self.r[start : start + len(mono)] += mono * np.sqrt(0.5 * (1 + pan))

    def stereo(self):
        return np.stack([self.l, self.r], axis=1)


def adsr(n, a=0.005, d=0.3, s=0.6, r=0.3, hold=None):
    hold = n / SR if hold is None else hold
    t = np.arange(n) / SR
    env = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)))
    rel = np.clip((t - hold) / max(r, 1e-6), 0, 1)
    return env * (1 - rel) ** 2


# MARK: Voices


def epiano(note, dur, vel=1.0):
    """An FM tine: a sine carrier with a 1:1 modulator whose index decays, plus a bright 14:1 tine click."""
    f = hz(note)
    n = int((dur + 1.6) * SR)
    t = np.arange(n) / SR
    index = 1.6 * vel * np.exp(-t / 0.35) + 0.25
    body = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    tine = 0.18 * vel * np.sin(2 * np.pi * f * 14.0 * t) * np.exp(-t / 0.03)
    detuned = 0.35 * np.sin(2 * np.pi * f * 1.003 * t + 0.6 * index * np.sin(2 * np.pi * f * 1.003 * t))
    env = adsr(n, a=0.003, d=1.1, s=0.25, r=0.5, hold=dur) * np.exp(-t / 3.0)
    tremolo = 1 + 0.12 * np.sin(2 * np.pi * 4.2 * t)
    return (body + tine + detuned) * env * tremolo * 0.36 * vel


def pad(note, dur):
    """Four detuned band-limited saws, low-passed, slow in and out."""
    f = hz(note)
    n = int((dur + 1.2) * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for cents in (-9, -3, 4, 10):
        fd = f * 2 ** (cents / 1200)
        phase = rng.uniform(0, 2 * np.pi)
        for k in range(1, int(4000 / fd) + 1):
            out += np.sin(2 * np.pi * fd * k * t + phase * k) / k
    b, a = signal.butter(2, 1100 / (SR / 2))
    out = signal.lfilter(b, a, out)
    return out * adsr(n, a=0.9, d=1.0, s=0.9, r=1.0, hold=dur) * 0.035


def bass(note, dur, vel=1.0):
    f = hz(note)
    n = int((dur + 0.2) * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return np.tanh(1.6 * tone) * adsr(n, a=0.008, d=0.5, s=0.7, r=0.12, hold=dur) * 0.30 * vel


def bell(note, dur, vel=1.0):
    f = hz(note)
    n = int((dur + 2.0) * SR)
    t = np.arange(n) / SR
    index = 2.2 * np.exp(-t / 0.25) + 0.15
    tone = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * 3.5 * t))
    return tone * adsr(n, a=0.002, d=0.6, s=0.18, r=0.8, hold=dur) * np.exp(-t / 2.2) * 0.21 * vel


def kick(vel=1.0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    freq = 48 + 95 * np.exp(-t / 0.035)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    click = rng.standard_normal(n) * np.exp(-t / 0.002) * 0.15
    return (np.sin(phase) * np.exp(-t / 0.22) + click) * 0.68 * vel


def rim(vel=1.0):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    b, a = signal.butter(2, [1400 / (SR / 2), 6500 / (SR / 2)], btype="band")
    snap = signal.lfilter(b, a, noise) * np.exp(-t / 0.09)
    tone = np.sin(2 * np.pi * 210 * t) * np.exp(-t / 0.04)
    return (snap * 0.9 + tone * 0.5) * 0.38 * vel


def hat(vel=1.0, open_=False):
    n = int((0.35 if open_ else 0.08) * SR)
    t = np.arange(n) / SR
    b, a = signal.butter(4, 7500 / (SR / 2), btype="high")
    noise = signal.lfilter(b, a, rng.standard_normal(n))
    return noise * np.exp(-t / (0.12 if open_ else 0.022)) * 0.16 * vel


def swell(length=0.9):
    """Filtered noise rising into a cut, peaking on it."""
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    # A sweeping band-pass, done in blocks.
    block = 1024
    for i in range(0, n, block):
        p = i / n
        lo = 300 + 3500 * p**2
        b, a = signal.butter(2, [lo / (SR / 2), min(lo * 2.4, 20000) / (SR / 2)], btype="band")
        out[i : i + block] = signal.lfilter(b, a, noise[i : i + block])
    return out * (t / length) ** 2.2 * 0.09


def reverb_ir(seconds=2.6, seed=1):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal((n, 2)) * np.exp(-t / (seconds / 6.5))[:, None]
    b, a = signal.butter(2, 6000 / (SR / 2))
    ir = signal.lfilter(b, a, ir, axis=0)
    ir[: int(0.012 * SR)] = 0  # pre-delay
    return ir / np.sqrt(np.sum(ir**2))


# MARK: The arrangement

# One chord a bar, round the loop: Fmaj9, Em7(add11), Dm9, G13; the last bar is Cmaj9.
CHORDS = [
    ("F2", ["A3", "C4", "E4", "G4"]),
    ("E2", ["G3", "B3", "D4", "A4"]),
    ("D2", ["F3", "A3", "C4", "E4"]),
    ("G2", ["F3", "B3", "E4", "A4"]),
]
FINAL = ("C2", ["E3", "G3", "B3", "D4", "G4"])

# A pentatonic line over four bars: (bar in the loop, beat, length in beats, note).
MOTIF = [
    (0, 0.5, 1.0, "E5"), (0, 1.5, 0.5, "G5"), (0, 2.0, 1.5, "A5"),
    (1, 0.5, 0.5, "G5"), (1, 1.0, 1.0, "E5"), (1, 2.0, 2.0, "D5"),
    (2, 0.5, 1.0, "C5"), (2, 1.5, 0.5, "D5"), (2, 2.0, 1.0, "E5"), (2, 3.0, 1.0, "G5"),
    (3, 0.0, 3.0, "E5"),
]

keys, pads, low, drums, lead, fx = Bus(), Bus(), Bus(), Bus(), Bus(), Bus()
kicks = []

for bar in range(BARS):
    b0 = bar * 4
    root, voicing = FINAL if bar == BARS - 1 else CHORDS[bar % 4]
    last = bar == BARS - 1
    # Keys: the chord on the one, a softer re-strike on the and of three (not in the intro or the last bar).
    for i, note in enumerate(voicing):
        spread = -0.5 + i / max(1, len(voicing) - 1)
        keys.add(at(b0) + int(i * 0.012 * SR), epiano(note, 2.4 if not last else 3.4, 0.9), pan=spread * 0.6)
        if 0 < bar < BARS - 1:
            keys.add(at(b0 + 2.5) + int(i * 0.01 * SR), epiano(note, 1.2, 0.55), pan=spread * 0.6)
    for note in voicing[:3]:
        pads.add(at(b0), pad(note, BAR if not last else BAR + 1.0), pan=0)
    if bar == 0:
        continue
    # Bass: the root, then the octave on the and of three, then a walk-up to the next root.
    bass_gain = 0.7 if last else 1.0
    low.add(at(b0), bass(root, 1.4 if not last else 3.0, bass_gain))
    if not last:
        octave = root[:-1] + str(int(root[-1]) + 1)
        low.add(at(b0 + 2.5), bass(octave, 0.6, 0.75))
        low.add(at(b0 + 3.5), bass(root, 0.4, 0.6))
    # Drums: kick on one and the and of three, rim on two and four, swung eighth hats.
    if last:
        drums.add(at(b0), kick(0.9))
        kicks.append(at(b0))
        continue
    for pos, vel in ((0, 1.0), (2.5, 0.8)):
        drums.add(at(b0 + pos), kick(vel))
        kicks.append(at(b0 + pos))
    if bar % 4 == 3:
        drums.add(at(b0 + 3.75), kick(0.45))
    for pos in (1, 3):
        drums.add(at(b0 + pos) + int(rng.uniform(-0.004, 0.004) * SR), rim(0.9 + rng.uniform(-0.1, 0.1)), pan=0.08)
    for i in range(8):
        swing = 0.12 if i % 2 else 0.0
        vel = (0.95 if i % 2 == 0 else 0.6) + rng.uniform(-0.12, 0.12)
        open_ = i == 7 and bar % 2 == 1
        drums.add(at(b0 + i * 0.5 + swing), hat(vel, open_), pan=0.3)

# The melody: the motif twice, through the middle of the film, the second pass a little brighter.
for start_bar, vel in ((5, 0.85), (9, 1.0)):
    for loop_bar, beat, length, note in MOTIF:
        lead.add(at((start_bar + loop_bar) * 4 + beat), bell(note, length * BEAT, vel), pan=0.15)
# A last bell on the final chord.
lead.add(at((BARS - 1) * 4), bell("G5", 2.5, 0.7), pan=-0.15)

# A swell into every scene change, and a light vinyl bed.
for cut in SCENES:
    s = swell()
    fx.add(int(cut / 30 * SR) - len(s), s, pan=rng.uniform(-0.3, 0.3))
crackle = np.zeros(N)
pops = rng.integers(0, N, int(LENGTH * 9))
crackle[pops] = rng.uniform(-1, 1, len(pops)) * rng.uniform(0.2, 1.0, len(pops))
b, a = signal.butter(2, [800 / (SR / 2), 6000 / (SR / 2)], btype="band")
crackle = signal.lfilter(b, a, crackle) * 0.05 + rng.standard_normal(N) * 0.0012
fx.add(0, crackle)

# MARK: Mix

# The kick ducks the keys, pad and bass a touch.
duck = np.ones(N)
shape = 1 - 0.32 * np.exp(-np.arange(int(0.3 * SR)) / SR / 0.08)
for k in kicks:
    seg = shape[: N - k]
    duck[k : k + len(seg)] = np.minimum(duck[k : k + len(seg)], seg)

dry = (keys.stereo() + pads.stereo() + low.stereo()) * duck[:, None]
dry += drums.stereo() * 0.9 + lead.stereo() + fx.stereo()
send = keys.stereo() * 0.35 + pads.stereo() * 0.5 + lead.stereo() * 0.6 + drums.stereo() * 0.12
ir = reverb_ir()
wet = np.stack([signal.fftconvolve(send[:, 0], ir[:, 0])[:N], signal.fftconvolve(send[:, 1], ir[:, 1])[:N]], axis=1)
mix = dry + wet * 0.55

# Warmth: no rumble below 32 Hz, a gentle low-pass, a soft clip; the last 1.2 s fades to silence.
b, a = signal.butter(2, 32 / (SR / 2), btype="high")
mix = signal.lfilter(b, a, mix, axis=0)
b, a = signal.butter(1, 15000 / (SR / 2))
mix = signal.lfilter(b, a, mix, axis=0)
mix = np.tanh(mix * 1.1) / 1.1
fade = np.ones(N)
tail = int(1.2 * SR)
fade[-tail:] = np.linspace(1, 0, tail) ** 2
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) / 0.89

os.makedirs(out_dir, exist_ok=True)
raw = os.path.join(out_dir, "bay-1.5.4.raw.wav")
with wave.open(raw, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
final = os.path.join(out_dir, "bay-1.5.4.wav")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-ar", str(SR), final], check=True)
os.remove(raw)
print(final)
