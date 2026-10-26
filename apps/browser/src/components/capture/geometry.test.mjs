import assert from "node:assert/strict";
import { test } from "node:test";
const { captureName, placeCapture } = await import("./geometry.ts");
const { CAPTURE_BAR_GAP, CAPTURE_BAR_HEIGHT, CAPTURE_MARGIN } = await import("./constants.ts");

const pane = { width: 1000, height: 800 };
const room = CAPTURE_BAR_HEIGHT + CAPTURE_BAR_GAP;

test("a capture with room stays where it was taken, its bar below it", () => {
  const from = { x: 200, y: 100, width: 300, height: 200 };
  const { image, barTop, barAbove } = placeCapture(from, pane);
  assert.deepEqual(image, from);
  assert.equal(barAbove, false);
  assert.equal(barTop, 300 + CAPTURE_BAR_GAP);
});

test("a capture at the bottom keeps its place and has its bar above", () => {
  const from = { x: 200, y: 700, width: 300, height: 80 };
  const { image, barTop, barAbove } = placeCapture(from, pane);
  assert.deepEqual(image, from);
  assert.equal(barAbove, true);
  assert.equal(barTop, 700 - room);
});

test("a capture of the whole pane shrinks about its centre to leave room for its bar", () => {
  const { image, barTop } = placeCapture({ x: 0, y: 0, ...pane }, pane);
  assert.ok(image.width < pane.width && image.height < pane.height);
  assert.ok(Math.abs(image.width / image.height - pane.width / pane.height) < 1e-9, "keeps its aspect");
  assert.ok(image.y >= CAPTURE_MARGIN && image.x >= CAPTURE_MARGIN);
  assert.ok(barTop + CAPTURE_BAR_HEIGHT <= pane.height - CAPTURE_MARGIN + 1e-9);
  assert.ok(Math.abs(image.x + image.width / 2 - pane.width / 2) < 1e-9, "centred");
});

test("a capture reaching past the pane is brought inside it", () => {
  const { image } = placeCapture({ x: -50, y: -400, width: 300, height: 1600 }, pane);
  assert.ok(image.x >= CAPTURE_MARGIN && image.y >= CAPTURE_MARGIN);
  assert.ok(image.y + image.height + room <= pane.height - CAPTURE_MARGIN + 1e-9);
});

test("a capture's name is its page's title and when, safe for a file", () => {
  const at = new Date(2026, 9, 25, 9, 5, 7);
  assert.equal(captureName("Golden Gate Bridge - Wikipedia", "https://en.wikipedia.org/wiki/x", at), "Golden Gate Bridge - Wikipedia 2026-10-25 at 09.05.07");
  assert.equal(captureName("a/b: c?", "https://x.test", at), "a b c 2026-10-25 at 09.05.07");
  assert.equal(captureName("", "https://news.ycombinator.com/item", at, true), "news.ycombinator.com (Full Page) 2026-10-25 at 09.05.07");
  assert.equal(captureName("", "not a url", at), "Capture 2026-10-25 at 09.05.07");
  assert.equal(captureName("x".repeat(100), "", at).length, 60 + " 2026-10-25 at 09.05.07".length);
});
