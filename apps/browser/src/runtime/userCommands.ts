import { executeLocalFileCommand, parseLocalFileCommand, LOCAL_FILE_COMMAND_METHODS, type LocalFileCommand } from "./localFileCommands";
import {
  executeImportCommand,
  parseImportCommand,
  IMPORT_COMMAND_METHODS,
  validateImportReply,
  type ImportCommand,
  type ImportCommandResult,
} from "./importCommands";
import { parseServiceCommand, parseServiceResult, type ServiceCommand, type ServiceResult } from "./serviceCommands";
import type { BrowserStore } from "../store/browser";
import { executeLocationCommand, parseLocationCommand, type LocationCommand, type LocationCommandEffects } from "./locationCommands";
import { executeTabCommand, parseTabCommand, TAB_COMMAND_METHODS, type TabCommand } from "./tabCommands";
import { executeWindowCommand, parseWindowCommand, WINDOW_COMMAND_METHODS, type WindowCommand } from "./windowCommands";
import { executeSettingsCommand, parseSettingsCommand, SETTINGS_COMMAND_METHODS, type SettingsCommand } from "./settingsCommands";
import { executeOrganizeCommand, ORGANIZE_COMMAND_METHODS, parseOrganizeCommand, type OrganizeCommand } from "./organizeCommands";
import { executeSplitCommand, parseSplitCommand, SPLIT_COMMAND_METHODS, type SplitCommand } from "./splitCommands";
import { executeSpaceCommand, parseSpaceCommand, SPACE_COMMAND_METHODS, type SpaceCommand } from "./spaceCommands";
import { BOOKMARK_COMMAND_METHODS, executeBookmarkCommand, parseBookmarkCommand, type BookmarkCommand } from "./bookmarkCommands";
import { executeHistoryCommand, HISTORY_COMMAND_METHODS, parseHistoryCommand, type HistoryCommand } from "./historyCommands";
import { executeWindowUiCommand, parseWindowUiCommand, WINDOW_UI_COMMAND_METHODS, type WindowUiCommand } from "./windowUiCommands";

export type BrowserCommand =
  | LocalFileCommand
  | LocationCommand
  | TabCommand
  | WindowCommand
  | SettingsCommand
  | OrganizeCommand
  | SplitCommand
  | SpaceCommand
  | BookmarkCommand
  | HistoryCommand
  | WindowUiCommand
  | ImportCommand
  | ServiceCommand;

// Keep in sync with RuntimeCommandResultKind in runtime_state.cc.
const ID_METHODS = [
  "createWindow",
  "newTab",
  "addCustomEngine",
  "createGroup",
  "groupTabs",
  "duplicateGroup",
  "newTabInGroup",
  "newPinnedFolder",
  "addSharedCollection",
  "createSplit",
  "createSpace",
  "addBookmark",
  "addBookmarkFolder",
] as const;
const OPTIONAL_ID_METHODS = ["duplicateTab", "moveTabsToWindow", "restoreCleaned", "openSplitPane", "openPeek", "removeBookmarks", "keepPeek"] as const;
export type BrowserCommandValue<C extends BrowserCommand> = C extends ImportCommand
  ? ImportCommandResult
  : C extends ServiceCommand
    ? ServiceResult
    : C extends { method: "pinLocalFiles" }
      ? string[]
      : C extends { method: (typeof ID_METHODS)[number] }
        ? string
        : C extends { method: (typeof OPTIONAL_ID_METHODS)[number] }
          ? string | null
          : null;

export function browserCommandResultKind(method: BrowserCommand["method"]): "id" | "optionalId" | "ids" | "json" | "none" {
  if (method === "pinLocalFiles") return "ids";
  if (method === "serviceAction" || (IMPORT_COMMAND_METHODS as readonly string[]).includes(method)) return "json";
  if ((ID_METHODS as readonly string[]).includes(method)) return "id";
  if ((OPTIONAL_ID_METHODS as readonly string[]).includes(method)) return "optionalId";
  return "none";
}

export function parseBrowserCommand(value: unknown): BrowserCommand {
  const method = value && typeof value === "object" && "method" in value ? value.method : undefined;
  if (typeof method === "string") {
    if ((LOCAL_FILE_COMMAND_METHODS as readonly string[]).includes(method)) return parseLocalFileCommand(value);
    if (method === "serviceAction") return parseServiceCommand(value);
    if ((IMPORT_COMMAND_METHODS as readonly string[]).includes(method)) return parseImportCommand(value);
    if ((TAB_COMMAND_METHODS as readonly string[]).includes(method)) return parseTabCommand(value);
    if ((WINDOW_COMMAND_METHODS as readonly string[]).includes(method)) return parseWindowCommand(value);
    if (SETTINGS_COMMAND_METHODS.includes(method)) return parseSettingsCommand(value);
    if ((ORGANIZE_COMMAND_METHODS as readonly string[]).includes(method)) return parseOrganizeCommand(value);
    if ((SPLIT_COMMAND_METHODS as readonly string[]).includes(method)) return parseSplitCommand(value);
    if ((SPACE_COMMAND_METHODS as readonly string[]).includes(method)) return parseSpaceCommand(value);
    if ((BOOKMARK_COMMAND_METHODS as readonly string[]).includes(method)) return parseBookmarkCommand(value);
    if ((HISTORY_COMMAND_METHODS as readonly string[]).includes(method)) return parseHistoryCommand(value);
    if ((WINDOW_UI_COMMAND_METHODS as readonly string[]).includes(method)) return parseWindowUiCommand(value);
  }
  return parseLocationCommand(value);
}

export function executeBrowserCommand(
  store: BrowserStore,
  command: BrowserCommand,
  effects?: LocationCommandEffects,
): string | string[] | null | ImportCommandResult {
  if ((LOCAL_FILE_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeLocalFileCommand(store, command as LocalFileCommand);
  if ((IMPORT_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeImportCommand(store, command as ImportCommand);
  if (command.method === "serviceAction") throw new Error("Service actions require the application owner");
  if ((TAB_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeTabCommand(store, command as TabCommand, effects);
  if ((WINDOW_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeWindowCommand(store, command as WindowCommand, effects);
  if (SETTINGS_COMMAND_METHODS.includes(command.method)) return executeSettingsCommand(store, command as SettingsCommand);
  if ((ORGANIZE_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeOrganizeCommand(store, command as OrganizeCommand);
  if ((SPLIT_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeSplitCommand(store, command as SplitCommand, effects);
  if ((SPACE_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeSpaceCommand(store, command as SpaceCommand);
  if ((BOOKMARK_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeBookmarkCommand(store, command as BookmarkCommand);
  if ((HISTORY_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeHistoryCommand(store, command as HistoryCommand);
  if ((WINDOW_UI_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeWindowUiCommand(store, command as WindowUiCommand);
  return executeLocationCommand(store, command as LocationCommand, effects);
}

export function validateBrowserCommandResult(command: BrowserCommand, value: unknown): boolean {
  const kind = browserCommandResultKind(command.method);
  if (kind === "ids") return Array.isArray(value) && value.length <= 10_000 && value.every((id) => typeof id === "string" && !!id.trim() && id.length <= 1024);
  if (kind === "id") return typeof value === "string" && !!value;
  if (kind === "optionalId") return value === null || (typeof value === "string" && !!value);
  if (command.method === "serviceAction") {
    try {
      parseServiceResult(value, command.action);
      return true;
    } catch {
      return false;
    }
  }
  if (kind === "json") return validateImportReply(command.method, value);
  return value === null;
}
