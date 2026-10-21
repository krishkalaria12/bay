import type { BrowserStore } from "../store/browser";
import { MAX_SPLIT_PANES } from "../store/constants";
import { isIncognitoSpace } from "../store/model";
import type { OpenPaneOptions, SplitSide } from "../store/splits";
import type { SplitView } from "../store/types";
import {
  commandBoolean,
  commandFields,
  commandIds,
  commandObject,
  commandText,
  commandUrl,
  invalidCommand,
  requireCommandSplit,
  requireCommandTab,
  requireCommandTabs,
  requireCommandWindow,
} from "./commandValidation";

// A link Chrome already opened (`adoptId`) is a native page handoff, not a user command.
export type UserPaneOptions = Omit<OpenPaneOptions, "adoptId">;
export type SplitPatch = { sizes?: number[]; stackSizes?: [number, number] };
export type SplitCommand =
  | { method: "createSplit"; tabIds: string[]; orientation?: SplitView["orientation"] }
  | { method: "openSplitPane"; windowId: string; options?: UserPaneOptions }
  | { method: "replaceSplitPane"; paneTabId: string; tabId: string }
  | { method: "removeTabFromSplit"; tabId: string }
  | { method: "separateSplit" | "flipSplit" | "toggleSplitOrientation"; splitId: string }
  | { method: "updateSplit"; splitId: string; patch: SplitPatch }
  | { method: "movePane"; tabId: string; delta: 1 | -1 }
  | { method: "focusPane"; windowId: string; delta: 1 | -1 }
  | { method: "toggleTabLayout" | "closePeek" | "keepPeek" | "splitPeek" | "reopenPeekOrClosed"; windowId: string }
  | { method: "openPeek"; fromTabId: string; url: string };

export const SPLIT_COMMAND_METHODS = [
  "createSplit",
  "openSplitPane",
  "replaceSplitPane",
  "removeTabFromSplit",
  "separateSplit",
  "flipSplit",
  "toggleSplitOrientation",
  "updateSplit",
  "movePane",
  "focusPane",
  "toggleTabLayout",
  "openPeek",
  "closePeek",
  "keepPeek",
  "splitPeek",
  "reopenPeekOrClosed",
] as const;

const SIDES: readonly string[] = ["left", "right", "top", "bottom"];
const side = (value: unknown): SplitSide => (typeof value === "string" && SIDES.includes(value) ? (value as SplitSide) : invalidCommand("invalid split side"));
const delta = (value: unknown): 1 | -1 => (value === 1 || value === -1 ? value : invalidCommand("invalid pane direction"));
function fractions(value: unknown, length?: number): number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SPLIT_PANES || (length !== undefined && value.length !== length))
    return invalidCommand("invalid split sizes");
  return Array.from(value, (size) =>
    typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 1 ? size : invalidCommand("invalid split size"),
  );
}

export function parseSplitCommand(value: unknown): SplitCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const tabId = () => commandText(c.tabId);
  const windowId = () => commandText(c.windowId);
  const splitId = () => commandText(c.splitId);
  switch (c.method) {
    case "createSplit": {
      fields("tabIds", "orientation");
      const tabIds = commandIds(c.tabIds);
      if (tabIds.length < 2 || tabIds.length > MAX_SPLIT_PANES) return invalidCommand("invalid split tabs");
      if (c.orientation !== undefined && c.orientation !== "horizontal" && c.orientation !== "vertical") return invalidCommand("invalid split orientation");
      return { method: c.method, tabIds, ...(c.orientation !== undefined ? { orientation: c.orientation } : {}) };
    }
    case "openSplitPane": {
      fields("windowId", "options");
      if (c.options === undefined) return { method: c.method, windowId: windowId() };
      const o = commandObject(c.options, ["tabId", "url", "anchorTabId", "side", "background"]);
      return {
        method: c.method,
        windowId: windowId(),
        options: commandFields<UserPaneOptions>(o, { tabId: commandText, url: commandUrl, anchorTabId: commandText, side, background: commandBoolean }),
      };
    }
    case "replaceSplitPane":
      fields("paneTabId", "tabId");
      return { method: c.method, paneTabId: commandText(c.paneTabId), tabId: tabId() };
    case "removeTabFromSplit":
      fields("tabId");
      return { method: c.method, tabId: tabId() };
    case "separateSplit":
    case "flipSplit":
    case "toggleSplitOrientation":
      fields("splitId");
      return { method: c.method, splitId: splitId() };
    case "updateSplit": {
      fields("splitId", "patch");
      const p = commandObject(c.patch, ["sizes", "stackSizes"]);
      return {
        method: c.method,
        splitId: splitId(),
        patch: commandFields<SplitPatch>(p, {
          sizes: (v) => fractions(v),
          stackSizes: (v) => fractions(v, 2) as [number, number],
        }),
      };
    }
    case "movePane":
      fields("tabId", "delta");
      return { method: c.method, tabId: tabId(), delta: delta(c.delta) };
    case "focusPane":
      fields("windowId", "delta");
      return { method: c.method, windowId: windowId(), delta: delta(c.delta) };
    case "toggleTabLayout":
    case "closePeek":
    case "keepPeek":
    case "splitPeek":
    case "reopenPeekOrClosed":
      fields("windowId");
      return { method: c.method, windowId: windowId() };
    case "openPeek":
      fields("fromTabId", "url");
      return { method: c.method, fromTabId: commandText(c.fromTabId), url: commandUrl(c.url) };
    default:
      return invalidCommand("unknown split command");
  }
}

export function executeSplitCommand(store: BrowserStore, command: SplitCommand): string | null {
  const s = store.getState();
  switch (command.method) {
    case "createSplit":
      requireCommandTabs(s, command.tabIds);
      return s.createSplit(command.tabIds, command.orientation) || invalidCommand("tabs cannot share a split");
    case "openSplitPane": {
      const window = requireCommandWindow(s, command.windowId);
      const o = command.options ?? {};
      for (const id of [o.tabId, o.anchorTabId]) {
        if (!id) continue;
        const tab = requireCommandTab(s, id);
        if (window.incognito ? tab.spaceId !== window.spaceId : isIncognitoSpace(tab.spaceId))
          return invalidCommand("tab cannot cross private window boundaries");
      }
      const result = s.openSplitPane(command.windowId, o);
      return result.ok ? result.tabId : null;
    }
    case "replaceSplitPane":
      requireCommandTabs(s, [command.paneTabId, command.tabId]);
      s.replaceSplitPane(command.paneTabId, command.tabId);
      break;
    case "removeTabFromSplit":
      requireCommandTab(s, command.tabId);
      s.removeTabFromSplit(command.tabId);
      break;
    case "movePane":
      requireCommandTab(s, command.tabId);
      s.movePane(command.tabId, command.delta);
      break;
    case "separateSplit":
    case "flipSplit":
    case "toggleSplitOrientation":
      requireCommandSplit(s, command.splitId);
      s[command.method](command.splitId);
      break;
    case "updateSplit":
      requireCommandSplit(s, command.splitId);
      s.updateSplit(command.splitId, command.patch);
      break;
    case "focusPane":
      requireCommandWindow(s, command.windowId);
      s.focusPane(command.windowId, command.delta);
      break;
    case "openPeek":
      requireCommandTab(s, command.fromTabId);
      return s.openPeek(command.fromTabId, command.url) ?? null;
    case "reopenPeekOrClosed":
      // One commit: a closed peek comes back over its tab, else the window's last closed tab.
      requireCommandWindow(s, command.windowId);
      if (!s.reopenPeek(command.windowId)) store.getState().reopenClosed(command.windowId);
      break;
    case "toggleTabLayout":
    case "closePeek":
    case "keepPeek":
    case "splitPeek":
      requireCommandWindow(s, command.windowId);
      s[command.method](command.windowId);
      break;
  }
  return null;
}
