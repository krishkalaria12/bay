import type { BrowserState, BrowserStore } from "../store/browser";
import { sidebarUndoWindow } from "../store/sidebarUndo";
import { localFilePath } from "../store/localFiles";
import type { LocalFilePin } from "../store/types";
import {
  commandBoolean,
  commandObject,
  commandOptionalText,
  commandText,
  invalidCommand,
  requireCommandSpace,
  requireCommandWindow,
} from "./commandValidation";

export type LocalFileDescriptor = Pick<LocalFilePin, "path" | "name" | "kind">;
export type LocalFileCommand =
  | { method: "pinLocalFiles"; windowId: string; files: LocalFileDescriptor[]; spaceId?: string }
  | { method: "renameLocalFile"; id: string; name: string }
  | { method: "removeLocalFile"; id: string }
  | { method: "moveLocalFile"; id: string; beforeId: string | null }
  | { method: "setLocalFileExpanded"; id: string; expanded: boolean };
export const LOCAL_FILE_COMMAND_METHODS = ["pinLocalFiles", "renameLocalFile", "removeLocalFile", "moveLocalFile", "setLocalFileExpanded"] as const;

export function parseLocalFileCommand(value: unknown): LocalFileCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  switch (c.method) {
    case "pinLocalFiles": {
      fields("windowId", "files", "spaceId");
      if (!Array.isArray(c.files) || c.files.length > 10_000) return invalidCommand("invalid local files");
      const files = Array.from(c.files, (value): LocalFileDescriptor => {
        const file = commandObject(value, ["path", "name", "kind"]);
        const path = localFilePath(commandText(file.path, 1_048_576));
        if (!path || (file.kind !== "file" && file.kind !== "folder")) return invalidCommand("invalid local file metadata");
        return { path, name: commandText(file.name).trim(), kind: file.kind };
      });
      return { method: c.method, windowId: commandText(c.windowId), files, ...(c.spaceId !== undefined ? { spaceId: commandText(c.spaceId) } : {}) };
    }
    case "renameLocalFile":
      fields("id", "name");
      return { method: c.method, id: commandText(c.id), name: commandText(c.name).trim() };
    case "removeLocalFile":
      fields("id");
      return { method: c.method, id: commandText(c.id) };
    case "moveLocalFile":
      fields("id", "beforeId");
      return { method: c.method, id: commandText(c.id), beforeId: commandOptionalText(c.beforeId) };
    case "setLocalFileExpanded":
      fields("id", "expanded");
      return { method: c.method, id: commandText(c.id), expanded: commandBoolean(c.expanded) };
    default:
      return invalidCommand("unknown local file command");
  }
}
function requireFile(s: BrowserState, id: string) {
  const file = Object.hasOwn(s.localFiles, id) ? s.localFiles[id] : undefined;
  if (!file || file.id !== id) return invalidCommand("local file no longer exists");
  requireCommandSpace(s, file.spaceId);
  return file;
}
export function executeLocalFileCommand(store: BrowserStore, c: LocalFileCommand): string[] | null {
  const s = store.getState();
  const originId = sidebarUndoWindow();
  if (originId) {
    const origin = requireCommandWindow(s, originId);
    if (origin.incognito || origin.kind === "small" || (c.method === "pinLocalFiles" && c.windowId !== originId))
      return invalidCommand("window cannot edit local files");
  }
  if (c.method === "pinLocalFiles") {
    const window = requireCommandWindow(s, c.windowId);
    if (window.incognito || window.kind === "small") return invalidCommand("window cannot hold local files");
    requireCommandSpace(s, c.spaceId ?? window.spaceId);
    return s.pinLocalFiles(c.windowId, c.files, c.spaceId);
  }
  const file = requireFile(s, c.id);
  switch (c.method) {
    case "renameLocalFile":
      s.renameLocalFile(c.id, c.name);
      break;
    case "removeLocalFile":
      s.removeLocalFile(c.id);
      break;
    case "moveLocalFile":
      if (c.beforeId && requireFile(s, c.beforeId).spaceId !== file.spaceId) return invalidCommand("local file position belongs to another space");
      s.moveLocalFile(c.id, c.beforeId);
      break;
    case "setLocalFileExpanded":
      s.setLocalFileExpanded(c.id, c.expanded);
      break;
  }
  return null;
}
