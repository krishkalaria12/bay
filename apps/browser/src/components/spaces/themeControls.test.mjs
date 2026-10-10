// The theme editor's wave (intensity) and dial (grain).
import assert from "node:assert/strict";
import { test } from "node:test";
const { dialPoint, dialValue, segment, wavePoints } = await import("./themeControls.ts");

test("the wave is a flat line at no intensity and swings its full height at full", () => {
  const flat = wavePoints(0, 100, 40, 0, 8, 20);
  assert.ok(flat.every((p) => p.y === 20));
  const full = wavePoints(0, 100, 40, 1, 8, 20);
  const ys = full.map((p) => p.y);
  assert.ok(Math.max(...ys) > 27.5 && Math.min(...ys) < 12.5);
  assert.equal(full.at(-1).x, 100, "it reaches the end");
  assert.ok(
    wavePoints(0, 100, 40, 2, 8, 20).every((p) => Math.abs(p.y - 20) <= 8),
    "clamped to 1",
  );
});

test("a segment is a bar centred between its points, at their angle", () => {
  const s = segment({ x: 0, y: 0 }, { x: 3, y: 4 });
  assert.deepEqual([s.x, s.y, s.length], [1.5, 2, 5]);
  assert.ok(Math.abs(s.angle - Math.atan2(4, 3)) < 1e-9);
});

test("the dial reads clockwise from the top, in sixteen steps, a full turn back to none", () => {
  assert.equal(dialValue(0, -10, 16), 0);
  assert.equal(dialValue(10, 0, 16), 0.25);
  assert.equal(dialValue(0, 10, 16), 0.5);
  assert.equal(dialValue(-10, 0, 16), 0.75);
  assert.equal(dialValue(-0.1, -10, 16), 0, "just short of a turn snaps back to 0");
  assert.equal(dialValue(10, -10, 16), 0.125);
});

test("a value points where the dial reads it", () => {
  for (const v of [0, 0.125, 0.25, 0.5, 0.8125]) {
    const p = dialPoint(v, 30);
    assert.equal(dialValue(p.x, p.y, 16), v);
  }
});
