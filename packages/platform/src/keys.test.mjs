import test from "node:test";
import assert from "node:assert/strict";
import {
  formatShortcut,
  LINUX_SHORTCUTS,
  menuShortcutStroke,
  parseShortcut,
  relabelShortcuts,
  strokeMatches,
  virtualKeyCode,
  windowsShortcutLabel,
  WINDOWS_SHORTCUTS,
} from "./keys.ts";
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
test("Linux keeps every Windows shortcut and adds Ctrl+Q and F11", () => {
  for (const [command, stroke] of Object.entries(WINDOWS_SHORTCUTS)) assert.deepEqual(LINUX_SHORTCUTS[command], stroke, command);
  assert.equal(windowsShortcutLabel("quit", "linux"), "Ctrl+Q");
  assert.equal(windowsShortcutLabel("toggleFullScreen", "linux"), "F11");
  assert.equal(windowsShortcutLabel("quit"), null); // Windows quits with Alt+F4, which the frame owns
  assert.equal(strokeMatches(LINUX_SHORTCUTS.quit, { key: "q", ctrlKey: true }), true);
  assert.equal(strokeMatches(LINUX_SHORTCUTS.toggleFullScreen, { key: "F11" }), true);
});
test("no web desktop shortcut uses Super, which the compositor owns", () => {
  const modifiers = new Set(["key", "mod", "shift", "alt", "ctrl"]);
  for (const [command, stroke] of Object.entries(LINUX_SHORTCUTS)) {
    for (const field of Object.keys(stroke)) assert.ok(modifiers.has(field), `${command} uses ${field}`);
    assert.equal(
      strokeMatches(stroke, { key: stroke.key, metaKey: true, ctrlKey: !!(stroke.mod || stroke.ctrl), shiftKey: !!stroke.shift, altKey: !!stroke.alt }),
      false,
      command,
    );
  }
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

test("global coordinates default to desktop support only on macOS and Windows", () => {
  for (const os of ["macos", "windows"]) assert.equal(capabilitiesFor(os, () => false).globalWindowCoordinates, true);
  assert.equal(capabilitiesFor("linux", () => true).globalWindowCoordinates, false);
});

test("every Windows and Linux shortcut key has the virtual-key code Chromium's key events carry", () => {
  assert.equal(virtualKeyCode("C"), 0x43);
  assert.equal(virtualKeyCode("c"), 0x43);
  assert.equal(virtualKeyCode("9"), 0x39);
  assert.equal(virtualKeyCode("F6"), 0x75);
  assert.equal(virtualKeyCode("Left"), 0x25);
  assert.equal(virtualKeyCode("="), 0xbb);
  assert.equal(virtualKeyCode("Pause"), null);
  for (const [command, stroke] of Object.entries(LINUX_SHORTCUTS)) assert.notEqual(virtualKeyCode(stroke.key), null, command);
});
