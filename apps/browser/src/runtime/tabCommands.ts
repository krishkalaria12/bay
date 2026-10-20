import type { LocationCommandEffects } from "./locationCommands";
import type { BrowserStore } from "../store/browser";
import { isIncognitoSpace } from "../store/model";
import type { NewTabOptions } from "../store/tabs";
import {
  commandBoolean,
  commandIds,
  commandIndex,
  commandObject,
  commandText,
  commandUrl,
  invalidCommand,
  requireCommandSpace,
  requireCommandTab,
  requireCommandWindow,
} from "./commandValidation";

export type UserNewTabOptions = Pick<NewTabOptions, "url" | "background" | "openerId" | "spaceId" | "pinned" | "index">;
export type TabCommand =
  | { method: "newTab"; windowId: string; options?: UserNewTabOptions }
  | { method: "activate" | "showTab"; tabId: string; windowId?: string | null }
  | { method: "closeTab" | "removeTab" | "duplicateTab" | "togglePin"; tabId: string }
  | { method: "closeTabs"; tabIds: string[] }
  | { method: "navigate"; tabId: string; url: string; options?: { userInitiated?: boolean } }
  | { method: "moveTab"; tabId: string; toIndex: number }
  | { method: "activateIndex"; windowId: string; index: number }
  | { method: "cycle"; windowId: string; delta: 1 | -1 };

export const TAB_COMMAND_METHODS = [
  "newTab",
  "activate",
  "showTab",
  "closeTab",
  "closeTabs",
  "removeTab",
  "navigate",
  "duplicateTab",
  "togglePin",
  "moveTab",
  "activateIndex",
  "cycle",
] as const;

function newTabOptions(value: unknown): UserNewTabOptions {
  const o = commandObject(value, ["url", "background", "openerId", "spaceId", "pinned", "index"]);
  return {
    ...(o.url !== undefined ? { url: commandUrl(o.url) } : {}),
    ...(o.background !== undefined ? { background: commandBoolean(o.background) } : {}),
    ...(o.openerId !== undefined ? { openerId: commandText(o.openerId) } : {}),
    ...(o.spaceId !== undefined ? { spaceId: commandText(o.spaceId) } : {}),
    ...(o.pinned !== undefined ? { pinned: commandBoolean(o.pinned) } : {}),
    ...(o.index !== undefined ? { index: commandIndex(o.index) } : {}),
  };
}
export function parseTabCommand(value: unknown): TabCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const tabId = () => commandText(c.tabId);
  const windowId = () => commandText(c.windowId);
  switch (c.method) {
    case "newTab":
      fields("windowId", "options");
      return { method: c.method, windowId: windowId(), ...(c.options !== undefined ? { options: newTabOptions(c.options) } : {}) };
    case "activate":
    case "showTab":
      fields("tabId", "windowId");
      return { method: c.method, tabId: tabId(), ...(c.windowId !== undefined ? { windowId: c.windowId === null ? null : windowId() } : {}) };
    case "closeTab":
    case "removeTab":
    case "duplicateTab":
    case "togglePin":
      fields("tabId");
      return { method: c.method, tabId: tabId() };
    case "closeTabs":
      fields("tabIds");
      return { method: c.method, tabIds: commandIds(c.tabIds) };
    case "navigate": {
      fields("tabId", "url", "options");
      const o = c.options !== undefined ? commandObject(c.options, ["userInitiated"]) : undefined;
      return {
        method: c.method,
        tabId: tabId(),
        url: commandUrl(c.url),
        ...(o ? { options: o.userInitiated !== undefined ? { userInitiated: commandBoolean(o.userInitiated) } : {} } : {}),
      };
    }
    case "moveTab":
      fields("tabId", "toIndex");
      return { method: c.method, tabId: tabId(), toIndex: commandIndex(c.toIndex) };
    case "activateIndex":
      fields("windowId", "index");
      return { method: c.method, windowId: windowId(), index: commandIndex(c.index, -1) };
    case "cycle":
      fields("windowId", "delta");
      if (c.delta !== 1 && c.delta !== -1) return invalidCommand("invalid cycle direction");
      return { method: c.method, windowId: windowId(), delta: c.delta };
    default:
      return invalidCommand("unknown tab command");
  }
}

/** Dispatch one user action. Native tab facts never enter this command boundary. */
export function executeTabCommand(store: BrowserStore, command: TabCommand, effects?: LocationCommandEffects): string | null {
  const s = store.getState();
  switch (command.method) {
    case "newTab": {
      const window = requireCommandWindow(s, command.windowId);
      const spaceId = command.options?.spaceId ?? window.spaceId;
      if (window.incognito) {
        if (spaceId !== window.spaceId) return invalidCommand("tab space does not belong to this window");
      } else requireCommandSpace(s, spaceId);
      if (command.options?.openerId) {
        const opener = requireCommandTab(s, command.options.openerId);
        if (opener.spaceId !== spaceId || (window.incognito && opener.windowId !== window.id)) return invalidCommand("opener belongs to another space");
      }
      return s.newTab(command.windowId, command.options);
    }
    case "closeTabs":
      command.tabIds.forEach((id) => requireCommandTab(s, id));
      s.closeTabs(command.tabIds);
      break;
    case "activateIndex":
      requireCommandWindow(s, command.windowId);
      s.activateIndex(command.windowId, command.index);
      break;
    case "cycle":
      requireCommandWindow(s, command.windowId);
      s.cycle(command.windowId, command.delta);
      break;
    default: {
      const tab = requireCommandTab(s, command.tabId);
      switch (command.method) {
        case "activate":
        case "showTab": {
          if (command.windowId) {
            const target = requireCommandWindow(s, command.windowId);
            if (target.incognito ? tab.spaceId !== target.spaceId : isIncognitoSpace(tab.spaceId))
              return invalidCommand("tab cannot cross private window boundaries");
            if ((target.kind === "small" || s.windows[tab.windowId]?.kind === "small") && tab.windowId !== target.id)
              return invalidCommand("tab belongs to another small window");
          }
          const target = command.method === "showTab" ? (command.windowId ?? (s.windows[tab.windowId] ? tab.windowId : undefined)) : command.windowId;
          s.activate(tab.id, target);
          const owner = store.getState().tabs[tab.id]?.windowId;
          if (command.method === "showTab" && owner && owner !== store.getState().ui.focusedWindowId) {
            store.getState().setFocusedWindow(owner);
            effects?.focusWindow(owner);
          }
          break;
        }
        case "navigate":
          s.navigate(tab.id, command.url, command.options);
          break;
        case "closeTab":
          s.closeTab(tab.id);
          break;
        case "removeTab":
          s.removeTab(tab.id);
          break;
        case "duplicateTab":
          return s.duplicateTab(tab.id) ?? null;
        case "togglePin":
          s.togglePin(tab.id);
          break;
        case "moveTab":
          s.moveTab(tab.id, command.toIndex);
          break;
      }
    }
  }
  return null;
}
