// Onboarding's intro music, synthesized as IntroMusic.swift does it: pads moving D → G → D with a low sine under them,
// a bell as the icon lands, a rising pentatonic pluck per letter of the name, and air and bells to finish. Pure maths,
// so the Chrome-hosted desktop plays the same piece through Web Audio.

import type { IntroMusicCues } from "./appMenu";

export const SAMPLE_RATE = 44_100;

const TABLE_SIZE = 4096;
let waveTable: Float32Array | null = null;
// Eight soft harmonics: the pads' tone.
function table(): Float32Array {
  if (waveTable) return waveTable;
  waveTable = new Float32Array(TABLE_SIZE + 1);
  for (let i = 0; i <= TABLE_SIZE; i++) {
    const x = (2 * Math.PI * i) / TABLE_SIZE;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * x) / Math.pow(k, 1.7);
    waveTable[i] = v / 1.5;
  }
  return waveTable;
}

const smooth = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(Math.max(x, 0), 1));
function envelope(t: number, length: number, attack: number, release: number) {
  if (t < attack) return smooth(t / attack);
  if (t > length) return 1 - smooth((t - length) / release);
  return 1;
}
function panGains(pan: number): [number, number] {
  const angle = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

class Mix {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly random: () => number;

  constructor(left: Float32Array, right: Float32Array, random: () => number) {
    this.left = left;
    this.right = right;
    this.random = random;
  }

  private frames(from: number, to: number): [number, number] {
    const a = Math.max(0, Math.floor(from * SAMPLE_RATE));
    return [a, Math.max(a, Math.min(this.left.length, Math.floor(to * SAMPLE_RATE)))];
  }

  pad(freq: number, from: number, to: number, attack: number, release: number, gain: number) {
    const wave = table();
    const detune = Math.pow(2, 4 / 1200);
    let phaseL = this.random();
    let phaseR = this.random();
    const incL = freq / detune / SAMPLE_RATE;
    const incR = (freq * detune) / SAMPLE_RATE;
    const a = 1 - Math.exp((-2 * Math.PI * Math.min(1600, freq * 5)) / SAMPLE_RATE);
    let lpL = 0;
    let lpR = 0;
    const lookup = (x: number) => {
      const i = Math.floor(x);
      return wave[i]! + (wave[i + 1]! - wave[i]!) * (x - i);
    };
    const [start, end] = this.frames(from, to + release);
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE - from;
      const env = envelope(t, to - from, attack, release) * gain;
      const shimmer = 1 + 0.04 * Math.sin(2 * Math.PI * 0.23 * t + freq);
      lpL += a * (lookup(phaseL * TABLE_SIZE) - lpL);
      lpR += a * (lookup(phaseR * TABLE_SIZE) - lpR);
      this.left[i]! += lpL * env * shimmer;
      this.right[i]! += lpR * env * (2 - shimmer);
      phaseL = (phaseL + incL) % 1;
      phaseR = (phaseR + incR) % 1;
    }
  }

  sine(freq: number, from: number, to: number, attack: number, release: number, gain: number) {
    const [start, end] = this.frames(from, to + release);
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE - from;
      const v = Math.sin(2 * Math.PI * freq * t) * envelope(t, to - from, attack, release) * gain;
      this.left[i]! += v;
      this.right[i]! += v;
    }
  }

  bell(freq: number, at: number, gain: number, pan: number) {
    const [gl, gr] = panGains(pan);
    const [start, end] = this.frames(at, at + 4.5);
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE - at;
      const index = 2.6 * Math.exp(-t / 0.35);
      const v = Math.sin(2 * Math.PI * freq * t + index * Math.sin(2 * Math.PI * freq * 1.4 * t));
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 1.4) * gain;
      this.left[i]! += v * env * gl;
      this.right[i]! += v * env * gr;
    }
  }

  pluck(freq: number, at: number, gain: number, pan: number) {
    const [gl, gr] = panGains(pan);
    const [start, end] = this.frames(at, at + 2);
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE - at;
      const x = 2 * Math.PI * freq * t;
      const v = Math.sin(x) + 0.25 * Math.sin(2 * x) * Math.exp(-t / 0.12) + 0.08 * Math.sin(3 * x) * Math.exp(-t / 0.06);
      const env = Math.min(1, t / 0.005) * Math.exp(-t / 0.42) * gain;
      this.left[i]! += v * env * gl;
      this.right[i]! += v * env * gr;
    }
  }

  air(from: number, peak: number, to: number, gain: number) {
    let seed = 0x9e3779b9;
    const noise = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return (seed >>> 8) / (1 << 23) - 1;
    };
    let lpL = 0;
    let lpR = 0;
    const [start, end] = this.frames(from, to);
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE;
      const rise = t < peak ? (t - from) / (peak - from) : 1 - (t - peak) / (to - peak);
      const shape = Math.max(0, rise) ** 2;
      const a = 1 - Math.exp((-2 * Math.PI * (250 + 2800 * shape)) / SAMPLE_RATE);
      lpL += a * (noise() - lpL);
      lpR += a * (noise() - lpR);
      this.left[i]! += lpL * shape * gain;
      this.right[i]! += lpR * shape * gain;
    }
  }

  normalize(target: number) {
    let peak = 0;
    for (let i = 0; i < this.left.length; i++) peak = Math.max(peak, Math.abs(this.left[i]!), Math.abs(this.right[i]!));
    if (!peak) return;
    const k = target / peak;
    for (let i = 0; i < this.left.length; i++) {
      this.left[i]! *= k;
      this.right[i]! *= k;
    }
  }

  fadeOut(seconds: number) {
    const frames = Math.min(this.left.length, Math.floor(seconds * SAMPLE_RATE));
    for (let j = 0; j < frames; j++) {
      const i = this.left.length - frames + j;
      const g = 0.5 + 0.5 * Math.cos((Math.PI * j) / frames);
      this.left[i]! *= g;
      this.right[i]! *= g;
    }
  }
}

/** The piece for these cues, as two channels at SAMPLE_RATE, peaking at 0.5. */
export function synthesizeIntroMusic(c: IntroMusicCues, random: () => number = Math.random): [Float32Array, Float32Array] {
  const length = Math.floor((c.end + 4.5) * SAMPLE_RATE);
  const mix = new Mix(new Float32Array(length), new Float32Array(length), random);
  const [d2, g2, d3, g3, a3, b3, d4] = [73.416, 97.999, 146.832, 195.998, 220.0, 246.942, 293.665];
  const [fs4, a4, cs5, e4, e5] = [369.994, 440.0, 554.365, 329.628, 659.255];
  const first = c.tagline + 0.35;
  const second = c.exit + 0.25;
  for (const f of [d3, a3, e4, a4]) mix.pad(f, 0, first, 1.8, 1.2, 0.15);
  for (const f of [g3, b3, d4, fs4]) mix.pad(f, c.tagline - 0.2, second, 1.1, 1.0, 0.14);
  for (const f of [d3, a3, fs4, cs5, e5]) mix.pad(f, c.exit - 0.1, c.end + 1.2, 0.6, 2.8, 0.13);
  mix.sine(d2, 0, first, 2.0, 1.2, 0.08);
  mix.sine(g2, c.tagline - 0.2, second, 1.0, 1.0, 0.07);
  mix.sine(d2, c.exit - 0.1, c.end + 1.2, 0.6, 2.8, 0.08);

  const land = c.icon + 0.35;
  mix.bell(587.33, land, 0.1, -0.15);
  mix.bell(880.0, land + 0.012, 0.07, 0.2);

  const pentatonic = new Set([2, 4, 6, 9, 11]);
  let midi = 69;
  const count = Math.max(0, c.letterCount);
  for (let i = 0; i < count; i++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const pan = (i % 2 === 0 ? -0.35 : 0.35) * (0.4 + (0.6 * i) / Math.max(1, count - 1));
    mix.pluck(freq, c.letters + i * c.letterStep + 0.03, 0.075 - 0.003 * i, pan);
    do midi++;
    while (!pentatonic.has(midi % 12));
  }

  mix.air(c.exit - 0.35, c.end, c.end + 1.4, 0.035);
  mix.bell(739.99, c.end - 0.05, 0.06, 0.25);
  mix.bell(1174.66, c.end + 0.03, 0.04, -0.25);
  mix.normalize(0.5);
  mix.fadeOut(1.5);
  return [mix.left, mix.right];
}
