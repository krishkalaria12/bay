// Keyboard vocabulary, written once for both platforms.
//
// The app's key bindings are named in Bay's own vocabulary: a `mod` modifier means Command on macOS
// and Control on Windows, and labels are formatted per platform. macOS shows glyphs ("⇧⌘C"), Windows
// shows words joined with "+" ("Ctrl+Shift+C"). Everything here is pure: pass the platform in.

import type { PlatformOS } from "./types";

export type Modifier = "mod" | "shift" | "alt" | "ctrl";

/**
 * A key combination, free of platform detail: `key` is the key's name as both keyboards spell it
 * (a letter, "Left", "F5", "Enter", "Tab", "[", ","); `mod` is the platform's command key.
 */
export type ShortcutStroke = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
};

/** The native modifier `mod` stands for, as the menus spell it (Menus.swift, Windows' ACCEL tables). */
export const modNativeName = (os: PlatformOS): "command" | "control" => (os === "macos" ? "command" : "control");

// The glyphs macOS hints are written with, and the modifier each stands for.
const GLYPHS: Record<string, Modifier> = { "⌃": "ctrl", "⌥": "alt", "⇧": "shift", "⌘": "mod" };
const GLYPH_OF: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" };
// macOS spells some keys as glyphs; Windows spells them as words.
const KEY_GLYPH_MAC: Record<string, string> = {
  return: "↩",
  enter: "↩",
  escape: "⎋",
  esc: "⎋",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  space: "␣",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};
const KEY_WORD_WINDOWS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  "←": "Left",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  "→": "Right",
  "↑": "Up",
  "↓": "Down",
  "↩": "Enter",
  "⎋": "Esc",
  "⌫": "Backspace",
  "⌦": "Delete",
  "⇥": "Tab",
  "␣": "Space",
};

export const isApplePlatform = (os: PlatformOS): boolean => os === "macos";

const keyLabel = (key: string, os: PlatformOS): string => {
  if (isApplePlatform(os)) {
    const glyph = KEY_GLYPH_MAC[key.toLowerCase()];
    return glyph && key.length > 1 ? glyph : key;
  }
  return KEY_WORD_WINDOWS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
};

/** "⇧⌘C" on macOS, "Ctrl+Shift+C" on Windows. */
export function formatShortcut(stroke: ShortcutStroke, os: PlatformOS): string {
  if (isApplePlatform(os)) {
    const parts: string[] = [];
    if (stroke.ctrl) parts.push(GLYPH_OF.ctrl);
    if (stroke.alt) parts.push(GLYPH_OF.alt);
    if (stroke.shift) parts.push(GLYPH_OF.shift);
    if (stroke.mod) parts.push(GLYPH_OF.mod);
    return parts.join("") + keyLabel(stroke.key, os);
  }
  // Windows: `mod` is Control, so a stroke with both is still one Ctrl.
  const parts: string[] = [];
  if (stroke.ctrl || stroke.mod) parts.push("Ctrl");
  if (stroke.alt) parts.push("Alt");
  if (stroke.shift) parts.push("Shift");
  parts.push(keyLabel(stroke.key, os));
  return parts.join("+");
}

/** A macOS hint ("⇧⌘C") as a stroke. Unknown keys pass through as they are. */
export function parseShortcut(hint: string): ShortcutStroke {
  const stroke: ShortcutStroke = { key: "" };
  let rest = hint;
  for (const [glyph, modifier] of Object.entries(GLYPHS)) {
    if (rest.includes(glyph)) {
      stroke[modifier] = true;
      rest = rest.split(glyph).join("");
    }
  }
  stroke.key = rest;
  return stroke;
}

const GLYPH_RUN = /([⌃⌥⇧⌘]+)([^\s()⌃⌥⇧⌘]{1,3})/g;

/**
 * Rewrites the ⌘-style hints inside a sentence for the platform: "Copy Link (⇧⌘C)" becomes
 * "Copy Link (Ctrl+Shift+C)" on Windows. Everywhere else the text is left alone, glyphs and all.
 */
export function relabelShortcuts(text: string, os: PlatformOS): string {
  if (isApplePlatform(os)) return text;
  return text.replace(GLYPH_RUN, (_all, glyphs: string, key: string) => formatShortcut({ ...parseShortcut(glyphs), key }, os));
}

/**
 * Bay's Windows shortcut table, by `BrowserCommand` id (packages/shell). Where Chrome on Windows has
 * a convention (chrome://settings/shortcuts), it wins; where Bay's macOS binding has no Windows
 * counterpart, the same key with Ctrl is kept. Conflicts with Chrome's own bindings are called out:
 * the app's menu model decides which one runs (Phase 5).
 */
export const WINDOWS_SHORTCUTS: Record<string, ShortcutStroke> = {
  newTab: { key: "T", mod: true },
  newWindow: { key: "N", mod: true },
  newIncognitoWindow: { key: "N", mod: true, shift: true },
  reopenClosedTab: { key: "T", mod: true, shift: true },
  reopenClosedWindow: { key: "T", mod: true, shift: true }, // after reopenClosedTab, as on macOS
  restoreClosed: { key: "T", mod: true, shift: true },
  focusCommandBar: { key: "L", mod: true }, // Chrome: Ctrl+L, Alt+D, F6
  closeTab: { key: "W", mod: true },
  closeAllTabs: { key: "W", mod: true, shift: true },
  print: { key: "P", mod: true },
  copyUrl: { key: "C", mod: true, shift: true }, // Chrome uses this for DevTools inspect; Bay's menu wins while DevTools is closed
  findInPage: { key: "F", mod: true },
  findNext: { key: "G", mod: true }, // Chrome: F3
  findPrevious: { key: "G", mod: true, shift: true }, // Chrome: Shift+F3
  useSelectionForFind: { key: "E", mod: true },
  reload: { key: "R", mod: true }, // Chrome also takes F5
  forceReload: { key: "R", mod: true, shift: true }, // Chrome also takes Ctrl+F5
  bookmarkPage: { key: "D", mod: true },
  bookmarkAllTabs: { key: "D", mod: true, shift: true },
  manageBookmarks: { key: "O", mod: true, shift: true }, // Chrome: Ctrl+Shift+O
  toggleBookmarksBar: { key: "B", mod: true, shift: true },
  showHistory: { key: "H", mod: true },
  downloads: { key: "J", mod: true },
  clearBrowsingData: { key: "Delete", mod: true, shift: true },
  devTools: { key: "I", mod: true, shift: true }, // Chrome also takes F12
  toggleDevTools: { key: "I", mod: true, shift: true },
  javaScriptConsole: { key: "J", mod: true, shift: true },
  inspectElements: { key: "C", mod: true, shift: true },
  viewSource: { key: "U", mod: true },
  savePage: { key: "S", mod: true },
  zoomIn: { key: "=", mod: true },
  zoomOut: { key: "-", mod: true },
  zoomReset: { key: "0", mod: true },
  back: { key: "Left", alt: true },
  forward: { key: "Right", alt: true },
  nextTab: { key: "Tab", mod: true },
  previousTab: { key: "Tab", mod: true, shift: true },
  selectTab: { key: "1", mod: true }, // Ctrl+1 … Ctrl+8, arg names the index
  selectLastTab: { key: "9", mod: true },
  focusNextPane: { key: "F6" },
  focusPreviousPane: { key: "F6", shift: true },
  toggleFullUrl: { key: "L", mod: true, shift: true },
  openSettings: { key: ",", mod: true }, // VS Code and Office use Ctrl+Comma; no Chrome convention
  searchTabs: { key: "A", mod: true, shift: true }, // Chrome: Ctrl+Shift+A
  toggleSidebar: { key: "B", mod: true }, // no Chrome convention; Ctrl+Shift+B stays the bookmarks bar
  tabSwitcher: { key: "Tab", mod: true },
  taskManager: { key: "Escape", shift: true },
  showOnboarding: { key: "F1" },
  keyboardShortcuts: { key: "/", mod: true },
  openFile: { key: "O", mod: true },
  newHarbor: { key: "N", mod: true, alt: true },
  openProfileMenu: { key: "P", mod: true, shift: true },
  moveTabUp: { key: "Up", mod: true, shift: true },
  moveTabDown: { key: "Down", mod: true, shift: true },
  moveTabToWindow: { key: "N", mod: true, shift: true },
  togglePin: { key: "P", mod: true, alt: true },
  toggleMute: { key: "M", mod: true },
  duplicateTab: { key: "K", mod: true },
  returnToPinnedUrl: { key: "Enter", mod: true },
};

/** "Ctrl+Shift+T" for a command, or null when the table has none. */
export function windowsShortcutLabel(command: string, os: PlatformOS = "windows"): string | null {
  const stroke = WINDOWS_SHORTCUTS[command];
  return stroke ? formatShortcut(stroke, os) : null;
}

/** Whether a key event (React Native's shape) is this stroke, for the Windows shell's key handling. */
export function strokeMatches(stroke: ShortcutStroke, event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): boolean {
  const key = keyLabel(event.key, "windows");
  const wanted = keyLabel(stroke.key, "windows");
  const same = key === wanted || event.key === stroke.key;
  const command = event.metaKey ?? false;
  const control = event.ctrlKey ?? false;
  return (
    same &&
    (!command && control === !!(stroke.mod || stroke.ctrl)) &&
    (stroke.shift ?? false) === (event.shiftKey ?? false) &&
    (stroke.alt ?? false) === (event.altKey ?? false)
  );
}
