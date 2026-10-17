import test from "node:test";
import assert from "node:assert/strict";
import { cancelAnimation, collectMotion, configureMotionClock, interpolate, makeMutable, withDelay, withRepeat, withSequence, withSpring, withTiming } from "./motion-runtime.ts";

function clock(reduced = false) {
  let time = 0, id = 0;
  const frames = new Map();
  configureMotionClock({ request: (fn) => (frames.set(++id, fn), id), cancel: (id) => frames.delete(id), now: () => time, reduced: () => reduced });
  return { tick(ms = 16) { time += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(time); }, pending: () => frames.size };
}
test("timing progresses, interruption preserves the current value and completes once", () => {
  const c = clock(); const value = makeMutable(0); const results = [];
  value.set(withTiming(10, { duration: 100 }, (done) => results.push(done)));
  c.tick(50); assert.equal(value.get(), 5);
  cancelAnimation(value); c.tick(100); assert.equal(value.get(), 5); assert.deepEqual(results, [false]);
  value.set(withTiming(10, { duration: 100 }, (done) => results.push(done)));
  c.tick(100); assert.equal(value.get(), 10); assert.deepEqual(results, [false, true]);
});
test("delay and sequence preserve order and completion", () => {
  const c = clock(); const value = makeMutable(0); const results = [];
  value.set(withSequence(withDelay(50, withTiming(1, { duration: 50 }, () => results.push(1))), withTiming(2, { duration: 50 }, () => results.push(2))));
  c.tick(40); assert.equal(value.get(), 0);
  c.tick(10); c.tick(50); assert.equal(value.get(), 1);
  c.tick(50); assert.equal(value.get(), 2); assert.deepEqual(results, [1, 2]);
});
test("repeat reverses and can cancel an infinite loop", () => {
  const c = clock(); const value = makeMutable(0);
  value.set(withRepeat(withTiming(1, { duration: 20 }), 2, true));
  c.tick(); c.tick(20); c.tick(); c.tick(20); assert.equal(value.get(), 0); assert.equal(c.pending(), 0);
  value.set(withRepeat(withTiming(1, { duration: 0 }), -1));
  c.tick(); c.tick(); cancelAnimation(value); assert.equal(c.pending(), 0);
});
test("spring settles and reduced motion completes at its target", () => {
  const c = clock(); const value = makeMutable(0);
  value.set(withSpring(20, { stiffness: 170, damping: 26 }));
  for (let i = 0; i < 500 && c.pending(); i++) c.tick();
  assert.equal(value.get(), 20); assert.equal(c.pending(), 0);
  const reduced = clock(true); value.set(withTiming(30)); reduced.tick(); assert.equal(value.get(), 30);
});
test("shared reads collect dependencies and subscriptions remove cleanly", () => {
  const value = makeMutable(1); const result = collectMotion(() => value.get() + value.value);
  assert.equal(result.value, 2); assert.equal(result.dependencies.size, 1);
  let calls = 0; const stop = [...result.dependencies][0].subscribe(() => calls++);
  value.set((v) => v + 1); assert.equal(calls, 1); stop(); value.set(3); assert.equal(calls, 1);
});
test("interpolation handles segments, extrapolation and clamps", () => {
  assert.equal(interpolate(15, [0, 10, 20], [0, 100, 0]), 50);
  assert.equal(interpolate(-5, [0, 10], [0, 100], "clamp"), 0);
  assert.equal(interpolate(-5, [0, 10], [0, 100]), -50);
});
