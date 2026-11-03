import {
  formatShortcut,
  isMac,
  menuKeyName,
  menuKeyOf,
  menuModifiersOf,
  menuShortcutStroke,
  platformOS,
  virtualKeyCode,
  WINDOWS_SHORTCUTS,
  type ShortcutStroke,
} from "@bay/platform";
import { menuShortcuts as nativeMenuShortcuts, type BrowserCommand, type KeyShortcut, type MenuShortcut } from "@bay/desktop";
import { SHORTCUT_ACTIONS } from "./shortcutCatalog";

// Commands in the table the app doesn't run itself yet: their keys stay Chrome's.
const LEFT_TO_CHROME = new Set(["closeAllTabs", "searchTabs", "taskManager", "showOnboarding", "returnToPinnedUrl"]);

/** No command: a key taken off its command, which stays taken so it doesn't go back to being Chrome's. */
export type KeyBinding = { command: BrowserCommand | ""; arg: string | null; stroke: ShortcutStroke };
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>;

// The table names selectTab's first key: Ctrl+1…8 select those tabs. The switcher's key goes forward, with Shift back.
const TAB_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8"];
function strokesFor(command: string, stroke: ShortcutStroke): { stroke: ShortcutStroke; arg: string | null }[] {
  if (command === "selectTab") return TAB_NUMBERS.map((n) => ({ stroke: { ...stroke, key: n }, arg: n }));
  if (command === "tabSwitcher")
    return [
      { stroke, arg: "forward" },
      { stroke: { ...stroke, shift: true }, arg: "backward" },
    ];
  return [{ stroke, arg: null }];
}

const labelOf = (stroke: ShortcutStroke) => formatShortcut(stroke, "windows");
const idOf = (command: string, arg: string | null) => (arg ? `${command}:${arg}` : command);
const actionIds = new Set(SHORTCUT_ACTIONS.map((action) => action.id));
const leftToChromeId = (id: string) => LEFT_TO_CHROME.has(id.split(":")[0]!);

/** The table's keys, as macOS's menu binds them: where two commands share a key the table's first wins (Ctrl+Shift+C
 *  copies the URL, as ⇧⌘C does). */
function defaultBindings(): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  const taken = new Set<string>();
  for (const [command, tableStroke] of Object.entries(WINDOWS_SHORTCUTS)) {
    if (LEFT_TO_CHROME.has(command)) continue;
    for (const { stroke, arg } of strokesFor(command, tableStroke)) {
      const label = labelOf(stroke);
      if (taken.has(label)) continue;
      taken.add(label);
      bindings.push({ command: command as BrowserCommand, arg, stroke });
    }
  }
  return bindings;
}

/** What Settings saved for an action, `[key, ...modifiers]` as menus spell them, as a stroke. */
const overrideStroke = (saved: readonly string[]): ShortcutStroke =>
  menuShortcutStroke(menuKeyName(saved[0] ?? ""), saved.slice(1) as Parameters<typeof menuShortcutStroke>[1]);

/** The window's keys. A key chosen in Settings comes first, and a default that was changed or removed no longer runs
 *  its command. */
export function keyBindings(overrides: ShortcutOverrides = {}): KeyBinding[] {
  const chosen = Object.entries(overrides).filter(([id]) => actionIds.has(id) && !leftToChromeId(id));
  const changed = new Set(chosen.map(([id]) => id));
  const bindings: KeyBinding[] = [];
  const taken = new Set<string>();
  const bind = (binding: KeyBinding) => {
    const label = labelOf(binding.stroke);
    if (taken.has(label)) return;
    taken.add(label);
    bindings.push(binding);
  };
  for (const [id, saved] of chosen) {
    if (!saved[0]) continue;
    const [command, arg] = id.split(":");
    bind({ command: command as BrowserCommand, arg: arg ?? null, stroke: overrideStroke(saved) });
  }
  const defaults = defaultBindings();
  for (const binding of defaults) if (!changed.has(idOf(binding.command, binding.arg))) bind(binding);
  for (const binding of defaults) if (changed.has(idOf(binding.command, binding.arg))) bind({ command: "", arg: null, stroke: binding.stroke });
  return bindings;
}

export function keyShortcuts(bindings: readonly KeyBinding[]): KeyShortcut[] {
  return bindings.flatMap(({ command, arg, stroke }) => {
    const keyCode = virtualKeyCode(stroke.key);
    return keyCode === null ? [] : [{ command, arg, keyCode, ctrl: !!(stroke.mod || stroke.ctrl), shift: !!stroke.shift, alt: !!stroke.alt }];
  });
}

/** The shortcut a key event is, by the same virtual key the host matches: Ctrl+Shift+1's event says "!", and a Russian
 *  layout's Ctrl+T says "е", but both are the key the shortcut names. */
export function shortcutForKeyEvent(shortcuts: readonly KeyShortcut[], event: KeyboardEvent): KeyShortcut | undefined {
  if (event.metaKey) return undefined;
  return shortcuts.find(
    (shortcut) => shortcut.keyCode === event.keyCode && shortcut.ctrl === event.ctrlKey && shortcut.shift === event.shiftKey && shortcut.alt === event.altKey,
  );
}

// Keys pages and the desktop own: listed so a shortcut that clashes with one says so, and not remappable.
const FIXED_SHORTCUTS: { title: string; path: string[]; stroke: ShortcutStroke; linuxOnly?: boolean }[] = [
  { title: "Undo", path: ["Edit"], stroke: { key: "Z", mod: true } },
  { title: "Redo", path: ["Edit"], stroke: { key: "Z", mod: true, shift: true } },
  { title: "Cut", path: ["Edit"], stroke: { key: "X", mod: true } },
  { title: "Copy", path: ["Edit"], stroke: { key: "C", mod: true } },
  { title: "Paste", path: ["Edit"], stroke: { key: "V", mod: true } },
  { title: "Select All", path: ["Edit"], stroke: { key: "A", mod: true } },
  { title: "Quit Bay", path: ["Bay"], stroke: { key: "Q", mod: true }, linuxOnly: true },
  { title: "Enter Full Screen", path: ["View"], stroke: { key: "F11" } },
];

const shortcutRow = (id: string, title: string, path: string[], stroke: ShortcutStroke | undefined, remappable: boolean): MenuShortcut => {
  const key = stroke ? menuKeyOf(stroke.key) : "";
  const modifiers = stroke ? menuModifiersOf(stroke) : [];
  return { id, title, path, key, modifiers, defaultKey: key, defaultModifiers: modifiers, remappable };
};

/** Settings' list of actions: the app menu's own on macOS, and the same actions by the table on other platforms. */
export function menuShortcuts(): Promise<MenuShortcut[]> {
  return isMac ? nativeMenuShortcuts() : Promise.resolve(shortcutCatalog());
}

export function shortcutCatalog(): MenuShortcut[] {
  const defaults = new Map(defaultBindings().map((binding) => [idOf(binding.command, binding.arg), binding.stroke]));
  const actions = SHORTCUT_ACTIONS.map(({ id, title, path }) =>
    leftToChromeId(id) ? shortcutRow(id, title, path, WINDOWS_SHORTCUTS[id], false) : shortcutRow(id, title, path, defaults.get(id), true),
  );
  const fixed = FIXED_SHORTCUTS.filter((row) => !row.linuxOnly || platformOS === "linux").map((row) =>
    shortcutRow(`std:${[...row.path, row.title].join(" > ")}`, row.title, row.path, row.stroke, false),
  );
  return [...actions, ...fixed];
}
