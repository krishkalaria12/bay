import type { SplitView } from "../store/types";
import { dispatchBrowserCommand } from "./commands";
import type { SplitPatch, UserPaneOptions } from "./splitCommands";

export const createSplit = (tabIds: string[], orientation?: SplitView["orientation"]) => dispatchBrowserCommand({ method: "createSplit", tabIds, orientation });
export const openSplitPane = (windowId: string, options?: UserPaneOptions) => dispatchBrowserCommand({ method: "openSplitPane", windowId, options });
export const replaceSplitPane = (paneTabId: string, tabId: string) => dispatchBrowserCommand({ method: "replaceSplitPane", paneTabId, tabId });
export const removeTabFromSplit = (tabId: string) => dispatchBrowserCommand({ method: "removeTabFromSplit", tabId });
export const separateSplit = (splitId: string) => dispatchBrowserCommand({ method: "separateSplit", splitId });
export const flipSplit = (splitId: string) => dispatchBrowserCommand({ method: "flipSplit", splitId });
export const toggleSplitOrientation = (splitId: string) => dispatchBrowserCommand({ method: "toggleSplitOrientation", splitId });
export const updateSplit = (splitId: string, patch: SplitPatch) => dispatchBrowserCommand({ method: "updateSplit", splitId, patch });
export const movePane = (tabId: string, delta: 1 | -1) => dispatchBrowserCommand({ method: "movePane", tabId, delta });
export const focusPane = (windowId: string, delta: 1 | -1) => dispatchBrowserCommand({ method: "focusPane", windowId, delta });
export const toggleTabLayout = (windowId: string) => dispatchBrowserCommand({ method: "toggleTabLayout", windowId });
export const openPeek = (fromTabId: string, url: string, point?: { x: number; y: number }) =>
  dispatchBrowserCommand({ method: "openPeek", fromTabId, url, ...(point ? { point } : {}) });
export const closePeek = (windowId: string) => dispatchBrowserCommand({ method: "closePeek", windowId });
export const keepPeek = (windowId: string) => dispatchBrowserCommand({ method: "keepPeek", windowId });
export const splitPeek = (windowId: string) => dispatchBrowserCommand({ method: "splitPeek", windowId });
export const reopenPeekOrClosed = (windowId: string) => dispatchBrowserCommand({ method: "reopenPeekOrClosed", windowId });
