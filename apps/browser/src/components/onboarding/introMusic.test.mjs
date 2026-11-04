import assert from "node:assert/strict";
import { test } from "node:test";
const { SAMPLE_RATE, synthesizeIntroMusic } = await import("../../../../../packages/desktop/src/introMusicSynth.ts");

const cues = { icon: 0.25, letters: 1.2, letterStep: 0.055, letterCount: 9, tagline: 2.4, exit: 4.1, end: 4.75 };
const seeded = () => {
  let seed = 1;
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
};
const peak = (data, from = 0, to = data.length) => data.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test("the piece runs to its end cue plus its tail, peaks at a half and fades to silence", () => {
  const [left, right] = synthesizeIntroMusic(cues, seeded());
  assert.equal(left.length, Math.floor((cues.end + 4.5) * SAMPLE_RATE));
  assert.equal(right.length, left.length);
  assert.ok(Math.abs(Math.max(peak(left), peak(right)) - 0.5) < 1e-6);
  assert.ok(peak(left, left.length - 10) < 1e-3);
  assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite));
});

test("the letters' plucks start at their cue, and nothing before it changes", () => {
  const quiet = synthesizeIntroMusic({ ...cues, letterCount: 0 }, seeded())[0];
  const plucked = synthesizeIntroMusic(cues, seeded())[0];
  // Each is normalized on its own, so compare after matching their scale where only the pads play.
  const loud = Math.floor(1.0 * SAMPLE_RATE);
  const scale = plucked[loud] / quiet[loud];
  const difference = (from, to) => {
    let most = 0;
    for (let i = from; i < to; i++) most = Math.max(most, Math.abs(plucked[i] - scale * quiet[i]));
    return most;
  };
  const cue = Math.floor((cues.letters + 0.03) * SAMPLE_RATE);
  assert.ok(difference(0, cue) < 1e-4);
  assert.ok(difference(cue, cue + 4000) > 0.01);
});
