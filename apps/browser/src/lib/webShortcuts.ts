import { isMac, strokeMatches } from "@bay/platform";
import { setKeyShortcuts } from "@bay/shell";
import { runCommand } from "./commands";
import { keyBindings, keyShortcuts } from "./keyBindings";

/** The Chrome-hosted desktop has no app menu to carry Bay's keys. Its host runs them while a page has focus and hands
 *  them to this document otherwise, where they run unless one of its own fields took the key first. */
export function startWebShortcuts() {
  if (isMac) return;
  const bindings = keyBindings();
  void setKeyShortcuts(keyShortcuts(bindings)).catch((error) => console.error("Couldn't register key shortcuts", error));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const binding = bindings.find(({ stroke }) => strokeMatches(stroke, event));
    if (!binding) return;
    event.preventDefault();
    runCommand({ command: binding.command, arg: binding.arg, windowId: null });
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
