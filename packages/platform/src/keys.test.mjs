import test from "node:test";
import assert from "node:assert/strict";
import { formatShortcut, parseShortcut, relabelShortcuts, strokeMatches, WINDOWS_SHORTCUTS } from "./keys.ts";
import { capabilitiesFor } from "./capabilities.ts";

test("desktop shortcut labels preserve Mac glyphs and spell Windows modifiers", () => {
  const stroke = parseShortcut("⌥⇧⌘C");
  assert.equal(formatShortcut(stroke, "macos"), "⌥⇧⌘C");
  assert.equal(formatShortcut(stroke, "windows"), "Ctrl+Alt+Shift+C");
  assert.equal(relabelShortcuts("Copy Link (⇧⌘C)", "windows"), "Copy Link (Ctrl+Shift+C)");
  assert.equal(relabelShortcuts("⌘-click to select", "windows"), "Ctrl+-click to select");
});
test("Windows shortcut matches Control, Alt navigation and explicit Control strokes", () => {
  assert.equal(strokeMatches(WINDOWS_SHORTCUTS.newTab, { key: "t", ctrlKey: true }), true);
  assert.equal(strokeMatches(WINDOWS_SHORTCUTS.newTab, { key: "t", metaKey: true }), false);
  assert.equal(strokeMatches(WINDOWS_SHORTCUTS.back, { key: "ArrowLeft", altKey: true }), true);
  assert.equal(strokeMatches({ key: "Tab", ctrl: true }, { key: "Tab", ctrlKey: true }), true);
});
test("Windows never advertises Apple-only features, even if a bridge shares module names", () => {
  const windows = capabilitiesFor("windows", () => true);
  for (const key of [
    "liquidGlass",
    "vibrancy",
    "shaders",
    "dock",
    "dockSelection",
    "calendar",
    "translation",
    "appleScript",
    "handoff",
    "introMusic",
    "trafficLights",
  ])
    assert.equal(windows[key], false, key);
  assert.equal(windows.keychain, true);
  const mac = capabilitiesFor("macos", () => false);
  assert.equal(mac.shaders, false);
  assert.equal(mac.keychain, false);
});
