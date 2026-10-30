import assert from "node:assert/strict";
import { test } from "node:test";
const { keyBindings, keyShortcuts } = await import("./keyBindings.ts");

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
