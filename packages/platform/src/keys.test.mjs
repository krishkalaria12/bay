import test from "node:test";
import assert from "node:assert/strict";
import { formatShortcut, menuShortcutStroke, parseShortcut, relabelShortcuts, strokeMatches, windowsShortcutLabel, WINDOWS_SHORTCUTS } from "./keys.ts";
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
test("Windows opens the same space menu command as macOS", () => {
  assert.equal(windowsShortcutLabel("openSpaceMenu"), "Ctrl+Shift+P");
  assert.equal(strokeMatches(WINDOWS_SHORTCUTS.openSpaceMenu, { key: "p", ctrlKey: true, shiftKey: true }), true);
  assert.equal(WINDOWS_SHORTCUTS.openProfileMenu, undefined);
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
test("Linux desktop uses the web host without Apple services", () => {
  const linux = capabilitiesFor("linux", () => true);
  assert.equal(linux.windowBackdrop, true);
  assert.equal(linux.hover, true);
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
    "menuBar",
  ])
    assert.equal(linux[key], false, key);
  assert.equal(linux.keychain, true);
});

test("web desktops draw caption buttons without native modules while macOS keeps traffic lights", () => {
  for (const os of ["windows", "linux"]) {
    const desktop = capabilitiesFor(os, () => false);
    assert.equal(desktop.captionButtons, true, os);
    assert.equal(desktop.trafficLights, false, os);
    assert.equal(desktop.menuBar, false, os);
  }
  const mac = capabilitiesFor("macos", () => true);
  assert.equal(mac.captionButtons, false);
  assert.equal(mac.trafficLights, true);
  assert.equal(mac.menuBar, true);
});

test("context-menu hints read as strokes on every desktop", () => {
  const copyLink = menuShortcutStroke("c", ["shift", "command"]);
  assert.equal(formatShortcut(copyLink, "windows"), "Ctrl+Shift+C");
  assert.equal(formatShortcut(copyLink, "linux"), "Ctrl+Shift+C");
  assert.equal(formatShortcut(menuShortcutStroke("2", ["control"]), "linux"), "Ctrl+2");
  assert.equal(formatShortcut(menuShortcutStroke("w", ["option", "command"]), "windows"), "Ctrl+Alt+W");
  assert.deepEqual(menuShortcutStroke("x"), { key: "x", mod: false, shift: false, alt: false, ctrl: false });
});
