import { dispatchBrowserCommand } from "./commands";
import type { UserNewTabOptions } from "./tabCommands";

export const newTab = (windowId: string, options?: UserNewTabOptions) => dispatchBrowserCommand({ method: "newTab", windowId, options });
export const activate = (tabId: string, windowId?: string | null) => dispatchBrowserCommand({ method: "activate", tabId, windowId });
export const navigate = (tabId: string, url: string, options?: { userInitiated?: boolean }) =>
  dispatchBrowserCommand({ method: "navigate", tabId, url, options });
export const closeTab = (tabId: string) => dispatchBrowserCommand({ method: "closeTab", tabId });
export const closeTabs = (tabIds: string[]) => dispatchBrowserCommand({ method: "closeTabs", tabIds });
export const removeTab = (tabId: string) => dispatchBrowserCommand({ method: "removeTab", tabId });
export const duplicateTab = (tabId: string) => dispatchBrowserCommand({ method: "duplicateTab", tabId });
export const togglePin = (tabId: string) => dispatchBrowserCommand({ method: "togglePin", tabId });
export const moveTab = (tabId: string, toIndex: number) => dispatchBrowserCommand({ method: "moveTab", tabId, toIndex });
export const activateIndex = (windowId: string, index: number) => dispatchBrowserCommand({ method: "activateIndex", windowId, index });
export const cycle = (windowId: string, delta: 1 | -1) => dispatchBrowserCommand({ method: "cycle", windowId, delta });
