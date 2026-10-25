import assert from "node:assert/strict";
import { test } from "node:test";
const { offscreenSide } = await import("./geometry.ts");

test("the window's tab is marked only once it's wholly out of the sidebar's view", () => {
  const row = { y: 400, height: 34 };
  // Viewport 300 tall, glow room 10 at its top.
  assert.equal(offscreenSide(row, 0, 300, 10), "below");
  assert.equal(offscreenSide(row, 100, 300, 10), "below"); // its top edge is the view's foot
  assert.equal(offscreenSide(row, 101, 300, 10), null); // a line of it shows
  assert.equal(offscreenSide(row, 300, 300, 10), null);
  assert.equal(offscreenSide(row, 424, 300, 10), "above"); // under the header's glow room
  assert.equal(offscreenSide(row, 423, 300, 10), null);
  assert.equal(offscreenSide(row, 600, 300, 10), "above");
});

test("nothing is marked before the list has laid out", () => {
  assert.equal(offscreenSide({ y: 400, height: 34 }, 0, 0, 10), null);
});
