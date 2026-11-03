// The intro music on the Chrome-hosted desktop: the same piece (introMusicSynth.ts) through Web Audio, with a hall
// reverb in place of AVAudioUnitReverb's .largeHall at 32% wet.

import type { IntroMusicCues } from "./appMenu";
import { SAMPLE_RATE, synthesizeIntroMusic } from "./introMusicSynth";

const VOLUME = 0.55;
const WET = 0.32;

let session = 0;
let context: AudioContext | null = null;
let output: GainNode | null = null;
let muted = false;

// A large hall's tail: two seconds and a half of decaying noise.
function hall(audio: AudioContext): AudioBuffer {
  const length = Math.floor(2.6 * audio.sampleRate);
  const impulse = audio.createBuffer(2, length, audio.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
  }
  return impulse;
}

function stopNow() {
  void context?.close().catch(() => {});
  context = null;
  output = null;
}

function rampTo(target: number, seconds: number) {
  if (!context || !output) return;
  const now = context.currentTime;
  output.gain.cancelScheduledValues(now);
  output.gain.setValueAtTime(output.gain.value, now);
  output.gain.linearRampToValueAtTime(target, now + Math.max(seconds, 0.01));
}

function start(left: Float32Array, right: Float32Array, late: number, current: number) {
  if (late * SAMPLE_RATE >= left.length) return;
  const audio = new AudioContext({ sampleRate: SAMPLE_RATE });
  const buffer = audio.createBuffer(2, left.length, SAMPLE_RATE);
  buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const dry = audio.createGain();
  dry.gain.value = 1 - WET;
  const wet = audio.createGain();
  wet.gain.value = WET;
  const reverb = audio.createConvolver();
  reverb.buffer = hall(audio);
  const gain = audio.createGain();
  // A late start (the piece took a moment to synthesize) comes in over 60 ms, as macOS's slice does.
  gain.gain.setValueAtTime(0, audio.currentTime);
  gain.gain.linearRampToValueAtTime(muted ? 0 : VOLUME, audio.currentTime + (late > 0 ? 0.06 : 0.001));
  source.connect(dry).connect(gain);
  source.connect(reverb).connect(wet).connect(gain);
  gain.connect(audio.destination);
  source.onended = () => setTimeout(() => session === current && stopNow(), 2500);
  source.start(0, Math.max(0, late));
  context = audio;
  output = gain;
}

export function playWebIntroMusic(cues: IntroMusicCues, mutedNow: boolean) {
  const requestedAt = performance.now();
  stopNow();
  const current = ++session;
  muted = mutedNow;
  // After this frame paints: synthesis takes a moment.
  setTimeout(() => {
    if (session !== current) return;
    const [left, right] = synthesizeIntroMusic(cues);
    if (session === current) start(left, right, (performance.now() - requestedAt) / 1000, current);
  }, 0);
}

export function setWebIntroMusicMuted(mutedNow: boolean) {
  muted = mutedNow;
  rampTo(muted ? 0 : VOLUME, 0.25);
}

export function stopWebIntroMusic(fade: number) {
  if (!context) return;
  const current = session;
  rampTo(0, fade);
  setTimeout(() => session === current && stopNow(), fade * 1000);
}
