import { isMac, webKeyClaimed } from "@bay/platform";
import { setKeyShortcuts, type KeyShortcut } from "@bay/desktop";
import { runCommand } from "./appCommands";
import { runAppCommand } from "./appMenuIntegration";
import { fieldKeepsKey, keyBindings, keyShortcuts, shortcutForKeyEvent } from "./keyBindings";
import { browserRead } from "../store/read";

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

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

  const run = (event: KeyboardEvent) => {
    const shortcut = shortcutForKeyEvent(shortcuts, event);

    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();

    if (!shortcut.command) return;
    // Both of onCommand's listeners, as a key the host runs has.
    const command = { command: shortcut.command, arg: shortcut.arg, windowId: null };
    runCommand(command);
    runAppCommand(command);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented) run(event);
  };

  // A text field stops every key it sees from bubbling, so window shortcuts are looked up on the way down, once it's
  // clear the field and the views around it don't take the key themselves.
  const onFieldKeyDown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && isTextField(event.target) && !fieldKeepsKey(event) && !webKeyClaimed(event)) run(event);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keydown", onFieldKeyDown, true);

  return () => {
    unsubscribe();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keydown", onFieldKeyDown, true);
  };
}
