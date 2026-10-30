import { formatShortcut, virtualKeyCode, WINDOWS_SHORTCUTS, type ShortcutStroke } from "@bay/platform";
import { type BrowserCommand, type KeyShortcut } from "@bay/shell";

// Commands in the table the app doesn't run itself yet: their keys stay Chrome's.
const LEFT_TO_CHROME = new Set(["closeAllTabs", "searchTabs", "tabSwitcher", "taskManager", "showOnboarding", "returnToPinnedUrl"]);

export type KeyBinding = { command: BrowserCommand; arg: string | null; stroke: ShortcutStroke };

// The table names selectTab's first key: Ctrl+1…8 select those tabs.
const TAB_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const strokesFor = (command: string, stroke: ShortcutStroke): { stroke: ShortcutStroke; arg: string | null }[] =>
  command === "selectTab" ? TAB_NUMBERS.map((n) => ({ stroke: { ...stroke, key: n }, arg: n })) : [{ stroke, arg: null }];

/** The window's keys, as macOS's menu binds them: where two commands share a key the table's first wins (Ctrl+Shift+C
 *  copies the URL, as ⇧⌘C does). */
export function keyBindings(): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  const taken = new Set<string>();
  for (const [command, tableStroke] of Object.entries(WINDOWS_SHORTCUTS)) {
    if (LEFT_TO_CHROME.has(command)) continue;
    for (const { stroke, arg } of strokesFor(command, tableStroke)) {
      const label = formatShortcut(stroke, "windows");
      if (taken.has(label)) continue;
      taken.add(label);
      bindings.push({ command: command as BrowserCommand, arg, stroke });
    }
  }
  return bindings;
}

export function keyShortcuts(bindings: readonly KeyBinding[]): KeyShortcut[] {
  return bindings.flatMap(({ command, arg, stroke }) => {
    const keyCode = virtualKeyCode(stroke.key);
    return keyCode === null ? [] : [{ command, arg, keyCode, ctrl: !!(stroke.mod || stroke.ctrl), shift: !!stroke.shift, alt: !!stroke.alt }];
  });
}
