import { isMac } from "@bay/platform";
import { setKeyShortcuts, type KeyShortcut } from "@bay/desktop";
import { runCommand } from "./appCommands";
import { keyBindings, keyShortcuts, shortcutForKeyEvent } from "./keyBindings";
import { browserRead } from "../store/read";

/** The Chrome-hosted desktop has no app menu to carry Bay's keys. Its host runs them while a page has focus and hands
 *  them to this document otherwise, where they run unless one of its own fields took the key first. Settings can
 *  change them at any time. */
export function startWebShortcuts() {
  if (isMac) return;
  let saved: string | null = null;
  let shortcuts: KeyShortcut[] = [];
  const apply = () => {
    const overrides = browserRead.getState().settings.shortcuts;
    const current = JSON.stringify(overrides);
    if (current === saved) return;
    saved = current;
    shortcuts = keyShortcuts(keyBindings(overrides));
    void setKeyShortcuts(shortcuts).catch((error) => console.error("Couldn't register key shortcuts", error));
  };
  apply();
  const unsubscribe = browserRead.subscribe(apply);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const shortcut = shortcutForKeyEvent(shortcuts, event);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut.command) runCommand({ command: shortcut.command, arg: shortcut.arg, windowId: null });
  };
  window.addEventListener("keydown", onKeyDown);
  return () => {
    unsubscribe();
    window.removeEventListener("keydown", onKeyDown);
  };
}
