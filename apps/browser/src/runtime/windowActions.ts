import { dispatchBrowserCommand } from "./commands";
import type { UserCreateWindowOptions } from "./windowCommands";

export const createWindow = (options?: UserCreateWindowOptions, openPanel = false) =>
  dispatchBrowserCommand({ method: "createWindow", options, ...(openPanel ? { openPanel } : {}) });
export const closeWindow = (windowId: string) => dispatchBrowserCommand({ method: "closeWindow", windowId });
export const toggleSidebar = (windowId: string) => dispatchBrowserCommand({ method: "toggleSidebar", windowId });
export const switchSpace = (windowId: string, spaceId: string) => dispatchBrowserCommand({ method: "switchSpace", windowId, spaceId });
export const moveTabsToWindow = (tabIds: string[], windowId: string | null) => dispatchBrowserCommand({ method: "moveTabsToWindow", tabIds, windowId });
export const moveTabToSpace = (tabId: string, spaceId: string) => dispatchBrowserCommand({ method: "moveTabToSpace", tabId, spaceId });
export const mergeAllWindows = (windowId: string) => dispatchBrowserCommand({ method: "mergeAllWindows", windowId });
export const reopenClosed = (windowId?: string | null) => dispatchBrowserCommand({ method: "reopenClosed", windowId });
export const reopenClosedTab = (windowId?: string | null) => dispatchBrowserCommand({ method: "reopenClosedTab", windowId });
export const reopenClosedWindow = () => dispatchBrowserCommand({ method: "reopenClosedWindow" });
export const restoreClosed = (entryId: string, windowId?: string | null) => dispatchBrowserCommand({ method: "restoreClosed", entryId, windowId });
