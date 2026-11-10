import type { JsonInput } from "../lib/json";
import * as v from "valibot";
import type { LocationCommandEffects } from "./locationCommands";
import type { BrowserStore } from "../store/browserStore";
import { activeTabId, isIncognitoSpace, resolveWindowId } from "../store/model";
import { mainWindowFor } from "../store/littleBay";
import type { Frame } from "../store/types";
import { validWindowSize } from "../store/windowPlacement";
import type { CreateWindowOptions } from "../store/windows";
import {
  commandBoolean,
  commandIds,
  commandObject,
  commandText,
  commandUrl,
  invalidCommand,
  requireCommandSpace,
  requireCommandTab,
  requireCommandWindow,
} from "./commandValidation";

export type UserCreateWindowOptions = Omit<CreateWindowOptions, "adoptId">;

export type WindowCommand =
  | { method: "createWindow"; options?: UserCreateWindowOptions; openPanel?: boolean }
  | { method: "closeWindow" | "toggleSidebar" | "mergeAllWindows" | "focusWindow" | "openInMainWindow"; windowId: string }
  | { method: "switchSpace"; windowId: string; spaceId: string }
  | { method: "moveTabsToWindow"; tabIds: string[]; windowId: string | null }
  | { method: "moveTabToSpace"; tabId: string; spaceId: string; windowId?: string }
  | { method: "reopenClosed" | "reopenClosedTab"; windowId?: string | null }
  | { method: "reopenClosedWindow" }
  | { method: "restoreClosed"; entryId: string; windowId?: string | null };

export const WINDOW_COMMAND_METHODS = [
  "createWindow",
  "closeWindow",
  "focusWindow",
  "openInMainWindow",
  "toggleSidebar",
  "switchSpace",
  "moveTabsToWindow",
  "moveTabToSpace",
  "mergeAllWindows",
  "reopenClosed",
  "reopenClosedTab",
  "reopenClosedWindow",
  "restoreClosed",
] as const;

function frame(value: JsonInput): Frame | null {
  if (value === null) return null;

  if (!Array.isArray(value) || value.length !== 4) return invalidCommand("invalid window frame");

  const numbers = value.map((item) => (v.is(v.number(), item) ? item : invalidCommand("invalid window frame")));

  if (!numbers.every((item) => Number.isFinite(item) && Math.abs(item) <= 1_000_000)) return invalidCommand("invalid window frame");

  const width = numbers[2] ?? 0;
  const height = numbers[3] ?? 0;

  if (width <= 0 || height <= 0) return invalidCommand("invalid window frame");

  // SAFETY: the checks above established this shape.
  return numbers as Frame;
}

function createOptions(value: JsonInput): UserCreateWindowOptions {
  const o = commandObject(value, ["spaceId", "incognito", "url", "tabIds", "frame", "size", "maximized", "small", "background"]);

  return {
    ...(o.spaceId !== undefined ? { spaceId: commandText(o.spaceId) } : undefined),
    ...(o.incognito !== undefined ? { incognito: commandBoolean(o.incognito) } : undefined),
    ...(o.url !== undefined ? { url: commandUrl(o.url) } : undefined),
    ...(o.tabIds !== undefined ? { tabIds: commandIds(o.tabIds) } : undefined),
    ...(o.frame !== undefined ? { frame: frame(o.frame) } : undefined),
    // SAFETY: the checks above established this shape.
    ...(o.size !== undefined ? { size: validWindowSize(o.size) ? ([...o.size] as [number, number]) : invalidCommand("invalid window size") } : undefined),
    ...(o.maximized !== undefined ? { maximized: commandBoolean(o.maximized) } : undefined),
    ...(o.small !== undefined ? { small: commandBoolean(o.small) } : undefined),
    ...(o.background !== undefined ? { background: commandBoolean(o.background) } : undefined),
  };
}

export function parseWindowCommand(value: JsonInput): WindowCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const windowId = () => commandText(c.windowId);
  const optionalWindow = () => (c.windowId !== undefined ? { windowId: c.windowId === null ? null : windowId() } : undefined);

  switch (c.method) {
    case "createWindow":
      fields("options", "openPanel");

      return {
        method: c.method,
        ...(c.options !== undefined ? { options: createOptions(c.options) } : undefined),
        ...(c.openPanel !== undefined ? { openPanel: commandBoolean(c.openPanel) } : undefined),
      };
    case "closeWindow":
    case "toggleSidebar":
    case "mergeAllWindows":
    case "focusWindow":
    case "openInMainWindow":
      fields("windowId");

      return { method: c.method, windowId: windowId() };
    case "switchSpace":
      fields("windowId", "spaceId");

      return { method: c.method, windowId: windowId(), spaceId: commandText(c.spaceId) };
    case "moveTabsToWindow":
      fields("tabIds", "windowId");

      return { method: c.method, tabIds: commandIds(c.tabIds), windowId: c.windowId === null ? null : windowId() };
    case "moveTabToSpace":
      fields("tabId", "spaceId", "windowId");

      return {
        method: c.method,
        tabId: commandText(c.tabId),
        spaceId: commandText(c.spaceId),
        ...(c.windowId !== undefined ? { windowId: windowId() } : undefined),
      };
    case "reopenClosed":
    case "reopenClosedTab":
      fields("windowId");

      return { method: c.method, ...optionalWindow() };
    case "reopenClosedWindow":
      fields();

      return { method: c.method };
    case "restoreClosed":
      fields("entryId", "windowId");

      return { method: c.method, entryId: commandText(c.entryId), ...optionalWindow() };
    default:
      return invalidCommand("unknown window command");
  }
}

/** All referenced entities are checked before invoking the existing window reducer. */
export function executeWindowCommand(store: BrowserStore, command: WindowCommand, effects?: LocationCommandEffects): string | null {
  const s = store.getState();

  switch (command.method) {
    case "openInMainWindow": {
      const window = requireCommandWindow(s, command.windowId);

      if (window.kind !== "small" || window.incognito) return invalidCommand("window is not a Little Bay");
      const tabId = activeTabId(s, window.id);
      const tab = tabId ? s.tabs[tabId] : undefined;
      let target = mainWindowFor(s, tab?.spaceId ?? window.spaceId);

      if (!tab?.url) {
        s.closeWindow(window.id);
        target ??= store.getState().createWindow({ spaceId: tab?.spaceId ?? window.spaceId });
      } else target = s.moveTabsToWindow([tab.id], target ?? null);

      if (target) {
        store.getState().setFocusedWindow(target);
        effects?.focusWindow(target);
      }

      break;
    }

    case "createWindow": {
      const o = command.options;

      if (o?.spaceId) requireCommandSpace(s, o.spaceId);

      if (o?.incognito && (o.spaceId || o.small || o.tabIds?.length)) return invalidCommand("private windows require a fresh private space");

      if (o?.small && o.tabIds?.length) return invalidCommand("small windows cannot receive existing tabs");

      for (const id of o?.tabIds ?? [])
        if (isIncognitoSpace(requireCommandTab(s, id).spaceId)) return invalidCommand("private tabs cannot move into a new window");
      const id = s.createWindow(o);

      if (command.openPanel) store.getState().openPanel(id);

      return id;
    }

    case "moveTabsToWindow": {
      const tabs = command.tabIds.map((id) => requireCommandTab(s, id));
      const target = command.windowId === null ? undefined : requireCommandWindow(s, command.windowId);

      if (target?.kind === "small") return invalidCommand("small windows cannot receive existing tabs");

      for (const tab of tabs) {
        if (target?.incognito ? tab.spaceId !== target.spaceId : isIncognitoSpace(tab.spaceId))
          return invalidCommand("tab cannot cross private window boundaries");
      }

      return s.moveTabsToWindow(command.tabIds, command.windowId) ?? null;
    }

    case "moveTabToSpace":
      if (isIncognitoSpace(requireCommandTab(s, command.tabId).spaceId)) return invalidCommand("private tabs cannot change spaces");
      requireCommandSpace(s, command.spaceId);

      if (command.windowId !== undefined) {
        const target = requireCommandWindow(s, command.windowId);

        if (target.incognito || target.kind === "small") return invalidCommand("window cannot receive a tab from another space");
      }

      s.moveTabToSpace(command.tabId, command.spaceId, command.windowId);
      break;
    case "switchSpace": {
      const window = requireCommandWindow(s, command.windowId);
      requireCommandSpace(s, command.spaceId);

      if (window.incognito || window.kind === "small") return invalidCommand("window cannot switch spaces");
      s.switchSpace(command.windowId, command.spaceId);
      break;
    }

    case "closeWindow":
    case "toggleSidebar":
    case "mergeAllWindows":
      requireCommandWindow(s, command.windowId);
      s[command.method](command.windowId);
      break;
    case "focusWindow":
      requireCommandWindow(s, command.windowId);
      s.setFocusedWindow(command.windowId);
      effects?.focusWindow(command.windowId);
      break;
    case "reopenClosedWindow":
      s.reopenClosedWindow();
      break;
    case "reopenClosed":
    case "reopenClosedTab":
    case "restoreClosed": {
      if (command.windowId) requireCommandWindow(s, command.windowId);

      if (command.method === "restoreClosed") {
        const tab = s.closedTabs.find((entry) => entry.id === command.entryId);
        const other = [...s.closedWindows, ...s.closedGroups, ...s.deletedGroups].find((entry) => entry.id === command.entryId);

        if (!tab && !other) return invalidCommand("closed entry no longer exists");
        const target = resolveWindowId(s, command.windowId);

        if (tab && (isIncognitoSpace(tab.tab.spaceId) ? tab.windowId !== target : !!s.windows[target ?? ""]?.incognito))
          return invalidCommand("closed tab cannot cross private window boundaries");

        if (other && s.windows[target ?? ""]?.incognito) return invalidCommand("closed entry cannot restore into a private window");
        s.restoreClosed(command.entryId, command.windowId);
      } else s[command.method](command.windowId);
      break;
    }
  }

  return null;
}
