import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
const { fieldKeepsKey, keyBindings, keyShortcuts, shortcutCatalog, shortcutForKeyEvent } = await import("./keyBindings.ts");
const { SHORTCUT_ACTIONS } = await import("./shortcutCatalog.ts");

const find = (shortcuts, keyCode, mods = {}) =>
  shortcuts.filter((s) => s.keyCode === keyCode && s.ctrl === !!mods.ctrl && s.shift === !!mods.shift && s.alt === !!mods.alt);

test("Ctrl+Shift+C copies the URL, as ⇧⌘C does, and no key runs two commands", () => {
  const shortcuts = keyShortcuts(keyBindings());
  assert.deepEqual(
    find(shortcuts, 0x43, { ctrl: true, shift: true }).map((s) => s.command),
    ["copyUrl"],
  );
  const keys = shortcuts.map((s) => `${s.keyCode}:${s.ctrl}:${s.shift}:${s.alt}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("Ctrl+1…8 select those tabs, Ctrl+9 the last", () => {
  const shortcuts = keyShortcuts(keyBindings());
  for (let n = 1; n <= 8; n++)
    assert.deepEqual(
      find(shortcuts, 0x30 + n, { ctrl: true }).map((s) => [s.command, s.arg]),
      [["selectTab", String(n)]],
    );
  assert.deepEqual(
    find(shortcuts, 0x39, { ctrl: true }).map((s) => s.command),
    ["selectLastTab"],
  );
});

test("commands the app doesn't run itself leave their keys to Chrome", () => {
  const commands = new Set(keyBindings().map((b) => b.command));
  for (const command of ["taskManager", "searchTabs", "closeAllTabs"]) assert.equal(commands.has(command), false, command);
});

test("a key chosen in Settings runs its command, and the old key runs nothing rather than Chrome's", () => {
  const shortcuts = keyShortcuts(keyBindings({ newTab: ["y", "command"] }));
  assert.deepEqual(
    find(shortcuts, 0x59, { ctrl: true }).map((s) => s.command),
    ["newTab"],
  );
  assert.deepEqual(
    find(shortcuts, 0x54, { ctrl: true }).map((s) => s.command),
    [""],
  );
});

test("a removed shortcut runs nothing, and doesn't pass its key to a command that lost it", () => {
  const shortcuts = keyShortcuts(keyBindings({ reopenClosedTab: [""] }));
  assert.deepEqual(
    find(shortcuts, 0x54, { ctrl: true, shift: true }).map((s) => s.command),
    [""],
  );
});

test("a chosen key takes over from the command that had it by default", () => {
  const shortcuts = keyShortcuts(keyBindings({ openLibrary: ["t", "command"] }));
  assert.deepEqual(
    find(shortcuts, 0x54, { ctrl: true }).map((s) => s.command),
    ["openLibrary"],
  );
});

test("special keys chosen in Settings reach the host by their virtual key", () => {
  const shortcuts = keyShortcuts(keyBindings({ openLibrary: ["\uf700", "option"], downloads: ["\uf70f"], stop: ["\u007f", "shift"], share: ["`", "command"] }));
  assert.deepEqual(
    find(shortcuts, 0x26, { alt: true }).map((s) => s.command),
    ["openLibrary"],
  );
  assert.deepEqual(
    find(shortcuts, 0x7b).map((s) => s.command),
    ["downloads"],
  );
  assert.deepEqual(
    find(shortcuts, 0x08, { shift: true }).map((s) => s.command),
    ["stop"],
  );
  assert.deepEqual(
    find(shortcuts, 0xc0, { ctrl: true }).map((s) => s.command),
    ["share"],
  );
});

test("an action's arg comes from its id", () => {
  const [binding] = keyBindings({ "setAppearance:dark": ["d", "option"] });
  assert.equal(binding.command, "setAppearance");
  assert.equal(binding.arg, "dark");
});

test("Settings can't bind what the app doesn't run, or an id only macOS has", () => {
  const commands = keyBindings({ closeAllTabs: ["y", "command"], togglePageEngine: ["y", "option"], "std:Edit > Copy": ["y", "shift"] }).map((b) => b.command);
  for (const command of ["closeAllTabs", "togglePageEngine", "std:Edit > Copy"]) assert.equal(commands.includes(command), false, command);
});

test("a key event finds its shortcut by virtual key, whatever character it types", () => {
  const shortcuts = keyShortcuts(keyBindings({ openLibrary: ["1", "shift", "command"] }));
  const event = (keyCode, mods = {}) => ({ keyCode, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  assert.equal(shortcutForKeyEvent(shortcuts, event(0x31, { ctrlKey: true, shiftKey: true, key: "!" })).command, "openLibrary");
  assert.equal(shortcutForKeyEvent(shortcuts, event(0x54, { ctrlKey: true, key: "е" })).command, "newTab");
  assert.equal(shortcutForKeyEvent(shortcuts, event(0x54, { ctrlKey: true, metaKey: true })), undefined);
  assert.equal(shortcutForKeyEvent(shortcuts, event(0x54)), undefined);
});

test("the catalog gives each action its winning default and marks what Chrome keeps", () => {
  const items = new Map(shortcutCatalog().map((item) => [item.id, item]));
  assert.deepEqual([items.get("newTab").defaultKey, items.get("newTab").defaultModifiers], ["t", ["command"]]);
  assert.deepEqual([items.get("back").defaultKey, items.get("back").defaultModifiers], ["\uf702", ["option"]]);
  assert.equal(items.get("copyUrl").defaultKey, "c");
  assert.equal(items.get("inspectElements").defaultKey, "", "Ctrl+Shift+C went to Copy URL");
  assert.equal(items.get("reopenClosedWindow").defaultKey, "");
  assert.equal(items.get("share").defaultKey, "");
  assert.equal(items.get("share").remappable, true);
  assert.equal(items.get("closeAllTabs").remappable, false);
  assert.equal(items.get("closeAllTabs").defaultKey, "w");
  assert.equal(items.get("std:Edit > Copy").remappable, false);
  assert.equal(items.size, shortcutCatalog().length, "ids are unique");
});

test("the catalog has the visible actions of macOS's menu", () => {
  const menus = readFileSync(new URL("../../../../packages/desktop/ios/Menus.swift", import.meta.url), "utf8");
  const ids = new Set(SHORTCUT_ACTIONS.map((action) => action.id));
  // WebKit is macOS's, and Move to New Window is under a menu Settings skips there too.
  const notHere = new Set(["togglePageEngine", "moveTabToWindow:new"]);
  const missing = [];
  for (const match of menus.matchAll(/cmd\("[^"]*", "(\w+)"(?:, arg: "(\w+)")?[^\n]*/g)) {
    if (match[0].includes(".hiddenShortcut()")) continue;
    const id = match[2] ? `${match[1]}:${match[2]}` : match[1];
    if (!ids.has(id) && !notHere.has(id)) missing.push(id);
  }
  assert.deepEqual(missing, []);
});

test("Ctrl+Tab opens the recent-tab switcher, as on macOS, and Ctrl+PageDown and PageUp step through tabs", () => {
  const shortcuts = keyShortcuts(keyBindings());
  assert.deepEqual(
    find(shortcuts, 0x09, { ctrl: true }).map((s) => [s.command, s.arg]),
    [["tabSwitcher", "forward"]],
  );
  assert.deepEqual(
    find(shortcuts, 0x09, { ctrl: true, shift: true }).map((s) => [s.command, s.arg]),
    [["tabSwitcher", "backward"]],
  );
  assert.deepEqual(
    find(shortcuts, 0x22, { ctrl: true }).map((s) => s.command),
    ["nextTab"],
  );
  assert.deepEqual(
    find(shortcuts, 0x21, { ctrl: true }).map((s) => s.command),
    ["previousTab"],
  );
});

test("a text field keeps what it types and edits with, and window shortcuts still reach past it", () => {
  const key = (name, mods = {}) => ({ key: name, ctrlKey: false, altKey: false, isComposing: false, ...mods });
  for (const typed of [key("a"), key("A"), key("Enter"), key("Tab"), key("ArrowLeft"), key("Backspace")]) assert.equal(fieldKeepsKey(typed), true, typed.key);
  for (const edit of [key("ArrowLeft", { ctrlKey: true }), key("Home", { ctrlKey: true }), key("Backspace", { ctrlKey: true })])
    assert.equal(fieldKeepsKey(edit), true, edit.key);
  assert.equal(fieldKeepsKey(key("t", { ctrlKey: true, isComposing: true })), true, "an IME is composing");
  for (const shortcut of [key("t", { ctrlKey: true }), key("ArrowLeft", { altKey: true }), key("F6"), key("F10")])
    assert.equal(fieldKeepsKey(shortcut), false, shortcut.key);
});
