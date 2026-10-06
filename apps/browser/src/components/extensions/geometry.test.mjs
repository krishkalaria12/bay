import assert from "node:assert/strict";
import { test } from "node:test";
const { extensionPopupGeometry } = await import("./geometry.ts");

test("extension popups opened from lower site-control tiles stay within the window", () => {
  const window = { width: 900, height: 640 };
  const popup = extensionPopupGeometry({ x: 220, y: 180, width: 52, height: 40 }, { width: 350, height: 450 }, window);
  assert.ok(popup.top + popup.height <= window.height - 8);
  assert.ok(popup.top >= 8);
  assert.equal(popup.height, 451);
});

test("oversized extension popups fit narrow windows", () => {
  const window = { width: 320, height: 400 };
  const popup = extensionPopupGeometry({ x: 240, y: 300, width: 52, height: 40 }, { width: 800, height: 600 }, window);
  assert.equal(popup.width, 304);
  assert.equal(popup.height, 384);
  assert.deepEqual([popup.left, popup.top], [8, 8]);
});

test("toolbar extension popups retain their anchor when they fit", () => {
  const popup = extensionPopupGeometry({ x: 1100, y: 10, width: 28, height: 28 }, { width: 300, height: 400 }, { width: 1280, height: 800 });
  assert.deepEqual(popup, { width: 301, height: 401, left: 827, top: 44 });
});
