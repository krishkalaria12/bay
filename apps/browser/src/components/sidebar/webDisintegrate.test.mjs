import assert from "node:assert/strict";
import { test } from "node:test";
const { specksFor, speckAt } = await import("./webDisintegrate.ts");

const row = { x: 10, y: 20, width: 100, height: 30 };

test("each speck keeps its colour and starts later the further right it is", () => {
  const specks = specksFor(row, [10, 25, 0, 0, 0, 255, 110, 25, 255, 128, 0, 128], () => 0);
  assert.equal(specks.length, 2);
  assert.equal(specks[0].color, "rgba(0, 0, 0, 1)");
  assert.equal(specks[1].color, "rgba(255, 128, 0, 0.5019607843137255)");
  assert.equal(specks[0].delay, 0);
  assert.equal(specks[1].delay, 0.22);
  assert.deepEqual(specks[0].drift, [-4, 21], "14 left and 1 up, the least it moves");
  assert.equal(specksFor(row, [1, 2, 3]).length, 0, "a partial run is ignored");
});

test("a speck waits where it was, drifts left, then scatters and fades away", () => {
  const [speck] = specksFor(row, [60, 30, 0, 0, 0, 255], () => 0.5);
  assert.deepEqual(speckAt(speck, 0), { x: 60, y: 30, opacity: 1 });
  const drifted = speckAt(speck, speck.delay + speck.life * 0.4);
  assert.ok(Math.abs(drifted.x - speck.drift[0]) < 1e-9);
  assert.ok(drifted.opacity > 0.75 && drifted.opacity < 1);
  const fading = speckAt(speck, speck.delay + speck.life * 0.85);
  assert.ok(fading.opacity > 0 && fading.opacity < 0.75);
  assert.equal(speckAt(speck, speck.delay + speck.life), null);
});
