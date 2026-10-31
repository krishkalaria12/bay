import type { BrowserStore } from "../store/browser";
import type { FindState } from "../store/types";
import { sidebarUndoWindow } from "../store/sidebarUndo";
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
  | { method: "clearDownloads"; windowId: string }
  | { method: "updateDownloadFile"; id: string; patch: { filename: string; path: string } };

export const WINDOW_UI_COMMAND_METHODS = ["setDownloadsOpen", "setFind", "removeDownload", "clearDownloads", "updateDownloadFile"] as const;

const MAX_FIND_QUERY = 4096;
const matchCount = (value: unknown) => (value === null ? null : commandIndex(value));

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
/** A rename keeps the file in its folder: only the last path component may change, and it must be the new name. */
export function renamesInPlace(from: string, to: { filename: string; path: string }): boolean {
  const folder = folderOf(from);
  const name = to.path.slice(folder.length);
  return !!folder && folderOf(to.path) === folder && name === to.filename && name !== "." && name !== ".." && !name.includes("\0");
}

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
    case "updateDownloadFile": {
      fields("id", "patch");
      const p = commandObject(c.patch, ["filename", "path"]);
      return { method: c.method, id: commandText(c.id), patch: { filename: commandText(p.filename), path: commandText(p.path, 32_768) } };
    }
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
    case "updateDownloadFile": {
      const download = s.downloads.find((d) => d.id === command.id);
      if (!download || download.state !== "finished" || !download.path || !renamesInPlace(download.path, command.patch))
        return invalidCommand("download cannot be renamed this way");
      const originId = sidebarUndoWindow();
      if (originId && !downloadVisibleIn(download, requireCommandWindow(s, originId))) return invalidCommand("download is not in this window's list");
      s.updateDownloadFile(command.id, command.patch);
      break;
    }
  }
  return null;
}
