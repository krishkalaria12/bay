import { browserRead } from "../store/read";
import { dispatchBrowserCommand } from "./commands";
import type { FindPatch } from "./windowUiCommands";

export const setDownloadsOpen = (windowId: string, open: boolean) => dispatchBrowserCommand({ method: "setDownloadsOpen", windowId, open });
export const toggleDownloads = (windowId: string) => setDownloadsOpen(windowId, !browserRead.getState().windowUi[windowId]?.downloadsOpen);
export const setFind = (tabId: string, patch: FindPatch) => dispatchBrowserCommand({ method: "setFind", tabId, patch });
export const removeDownload = (windowId: string, downloadId: string) => dispatchBrowserCommand({ method: "removeDownload", windowId, downloadId });
export const clearDownloads = (windowId: string) => dispatchBrowserCommand({ method: "clearDownloads", windowId });
// The command panel's own commands (runtime/locationCommands.ts).
export const openCommandPanel = (windowId: string, initialText?: string) => dispatchBrowserCommand({ method: "openCommandPanel", windowId, initialText });
export const dismissCommandPanel = (windowId: string) => dispatchBrowserCommand({ method: "dismissCommandPanel", windowId });
