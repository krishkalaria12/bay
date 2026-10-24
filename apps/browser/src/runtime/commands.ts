import { focusWindow } from "@bay/shell";
import { useBrowser, type BrowserStore } from "../store/browser";
import type { LocationCommandEffects } from "./locationCommands";
import { executeBrowserCommand, parseBrowserCommand, type BrowserCommand, type BrowserCommandValue } from "./userCommands";
import type { createBrowserClient } from "./client";

export type BrowserCommands = { dispatch<C extends BrowserCommand>(command: C): Promise<BrowserCommandValue<C>> };

/** Execute before returning the Promise, preserving local macOS reducer timing. */
export function createLocalBrowserCommands(store: BrowserStore, effects: LocationCommandEffects = { focusWindow() {} }): BrowserCommands {
  return {
    dispatch<C extends BrowserCommand>(command: C) {
      try {
        return Promise.resolve(executeBrowserCommand(store, parseBrowserCommand(command), effects) as BrowserCommandValue<C>);
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
export const dispatchBrowserCommand = <C extends BrowserCommand>(command: C): Promise<BrowserCommandValue<C>> => current.dispatch(command);

/** Event handlers must observe failures, including remote rejection. Never retry
 * a mutation whose outcome may be uncertain after a disconnection.
 */
export function reportBrowserCommand(command: Promise<unknown>): void {
  void command.catch((error) => console.error("Browser command failed", error));
}
