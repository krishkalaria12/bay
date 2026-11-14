import assert from "node:assert/strict";
import { test } from "node:test";

const { DEFAULT_LITTLE_BAY_SHORTCUT, hotKeyCode } = await import("./access.ts");

test("macOS registers its own key code, and other platforms the virtual key the name means", () => {
  assert.equal(hotKeyCode(DEFAULT_LITTLE_BAY_SHORTCUT, true), 45);
  assert.equal(hotKeyCode(DEFAULT_LITTLE_BAY_SHORTCUT, false), 0x4e);
  assert.equal(hotKeyCode({ key: "\uf700", keyCode: 126 }, false), 0x26);
  assert.equal(hotKeyCode({ key: "\uf704", keyCode: 122 }, false), 0x70);
});
