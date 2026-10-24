import type { BrowserStore } from "../store/browser";
import type { FindState } from "../store/types";
import { downloadVisibleIn } from "../store/ui";
import {
  commandBoolean,
  commandFields,
  commandIndex,
  commandObject,
  commandText,
  commandTimestamp,
  invalidCommand,
  requireCommandTab,
  requireCommandWindow,
} from "./commandValidation";

export type FindPatch = Partial<FindState>;
export type WindowUiCommand =
  | { method: "setDownloadsOpen"; windowId: string; open: boolean }
  | { method: "setFind"; tabId: string; patch: FindPatch }
  | { method: "removeDownload"; windowId: string; downloadId: string }
  | { method: "clearDownloads"; windowId: string };

export const WINDOW_UI_COMMAND_METHODS = ["setDownloadsOpen", "setFind", "removeDownload", "clearDownloads"] as const;

const MAX_FIND_QUERY = 4096;
const matchCount = (value: unknown) => (value === null ? null : commandIndex(value));

export function parseWindowUiCommand(value: unknown): WindowUiCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const windowId = () => commandText(c.windowId);
  switch (c.method) {
    case "setDownloadsOpen":
      fields("windowId", "open");
      return { method: c.method, windowId: windowId(), open: commandBoolean(c.open) };
    case "setFind": {
      fields("tabId", "patch");
      const p = commandObject(c.patch, ["open", "query", "count", "active", "focusRequest", "replace"]);
      return {
        method: c.method,
        tabId: commandText(c.tabId),
        patch: commandFields<FindPatch>(p, {
          open: commandBoolean,
          query: (v) => commandText(v, MAX_FIND_QUERY, true),
          count: matchCount,
          active: commandIndex,
          focusRequest: commandTimestamp,
          replace: commandBoolean,
        }),
      };
    }
    case "removeDownload":
      fields("windowId", "downloadId");
      return { method: c.method, windowId: windowId(), downloadId: commandText(c.downloadId) };
    case "clearDownloads":
      fields("windowId");
      return { method: c.method, windowId: windowId() };
    default:
      return invalidCommand("unknown window UI command");
  }
}

export function executeWindowUiCommand(store: BrowserStore, command: WindowUiCommand): null {
  const s = store.getState();
  switch (command.method) {
    case "setDownloadsOpen":
      requireCommandWindow(s, command.windowId);
      s.setDownloadsOpen(command.windowId, command.open);
      break;
    case "setFind":
      requireCommandTab(s, command.tabId);
      s.setFind(command.tabId, command.patch);
      break;
    case "removeDownload": {
      // A window lists only its own kind of downloads (a private window's, or every regular one).
      const window = requireCommandWindow(s, command.windowId);
      const download = s.downloads.find((d) => d.id === command.downloadId);
      if (!download || !downloadVisibleIn(download, window)) return invalidCommand("download is not in this window's list");
      s.removeDownload(command.downloadId);
      break;
    }
    case "clearDownloads":
      requireCommandWindow(s, command.windowId);
      s.clearDownloads(command.windowId);
      break;
  }
  return null;
}
