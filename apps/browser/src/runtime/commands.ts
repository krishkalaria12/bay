import { focusWindow } from "@bay/shell";
import { useBrowser, type BrowserStore } from "../store/browser";
import { executeLocationCommand, parseLocationCommand, type LocationCommand, type LocationCommandEffects } from "./locationCommands";
import type { createBrowserClient } from "./client";

export type BrowserCommands = { dispatch(command: LocationCommand): Promise<null> };

/** Execute before returning the Promise, preserving local macOS reducer timing. */
export function createLocalBrowserCommands(store: BrowserStore, effects: LocationCommandEffects = { focusWindow() {} }): BrowserCommands {
  return {
    dispatch(command) {
      try {
        return Promise.resolve(executeLocationCommand(store, parseLocationCommand(command), effects));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
export function createClientBrowserCommands(client: Pick<ReturnType<typeof createBrowserClient>, "dispatch">): BrowserCommands {
  return { dispatch: (command) => client.dispatch(command) };
}

const local = createLocalBrowserCommands(useBrowser, {
  focusWindow(id) {
    try {
      void Promise.resolve(focusWindow(id)).catch((error) => console.error("Couldn't focus the browser window", error));
    } catch (error) {
      console.error("Couldn't focus the browser window", error);
    }
  },
});
const bindings = [{ commands: local }];
let current = local;
/** Explicit runtime setup only. A remote command resolves after its client has
 * installed the acknowledged commit; no reducer API is added to the mirror.
 */
export function installBrowserCommands(next: BrowserCommands) {
  const binding = { commands: next };
  bindings.push(binding);
  current = next;
  return () => {
    const index = bindings.indexOf(binding);
    if (index < 0) return;
    const active = index === bindings.length - 1;
    bindings.splice(index, 1);
    if (active) current = bindings[bindings.length - 1]!.commands;
  };
}
export const dispatchBrowserCommand = (command: LocationCommand): Promise<null> => current.dispatch(command);
