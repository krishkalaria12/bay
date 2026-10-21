import type { BrowserState, BrowserStore } from "../store/browser";
import { activeTabId, isIncognitoSpace, tabListKey } from "../store/model";
import { mainWindowFor } from "../store/small";

export type LocationCommand =
  | { method: "openLocation"; sourceTabId: string; url: string; disposition: "current" | "newTab" | "backgroundTab" | "newWindow" }
  | { method: "switchToExistingTab"; sourceTabId: string; targetTabId: string }
  | { method: "requestNewTab"; windowId: string; groupId?: string }
  | { method: "submitNewTab"; windowId: string; url: string }
  | { method: "dismissCommandPanel"; windowId: string }
  | { method: "openCommandPanel"; windowId: string; initialText?: string; sourceTabId?: string };

export type LocationCommandEffects = { focusWindow(windowId: string): void };

export class LocationCommandError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "LocationCommandError";
  }
}

const invalid = (message: string): never => {
  throw new LocationCommandError(message);
};
const MAX_TEXT_LENGTH = 1_048_576;
const MAX_ID_LENGTH = 1024;
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > limit) return invalid("invalid command text");
  return value;
}

/** Only user intents cross this boundary; spaces and opener relationships come from the store. */
export function parseLocationCommand(value: unknown): LocationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid("expected a command object");
  const c = value as Record<string, unknown>;
  const fields = (...allowed: string[]) => {
    if (Object.keys(c).some((key) => !allowed.includes(key))) invalid("unexpected command field");
  };
  const windowId = () => text(c.windowId, MAX_ID_LENGTH);
  switch (c.method) {
    case "openLocation": {
      fields("method", "sourceTabId", "url", "disposition");
      const disposition = c.disposition;
      if (disposition !== "current" && disposition !== "newTab" && disposition !== "backgroundTab" && disposition !== "newWindow")
        return invalid("invalid location disposition");
      return { method: c.method, sourceTabId: text(c.sourceTabId, MAX_ID_LENGTH), url: text(c.url, MAX_TEXT_LENGTH), disposition };
    }
    case "switchToExistingTab":
      fields("method", "sourceTabId", "targetTabId");
      return { method: c.method, sourceTabId: text(c.sourceTabId, MAX_ID_LENGTH), targetTabId: text(c.targetTabId, MAX_ID_LENGTH) };
    case "requestNewTab":
      fields("method", "windowId", "groupId");
      return { method: c.method, windowId: windowId(), ...(c.groupId !== undefined ? { groupId: text(c.groupId, MAX_ID_LENGTH) } : {}) };
    case "submitNewTab":
      fields("method", "windowId", "url");
      return { method: c.method, windowId: windowId(), url: text(c.url, MAX_TEXT_LENGTH) };
    case "dismissCommandPanel":
      fields("method", "windowId");
      return { method: c.method, windowId: windowId() };
    case "openCommandPanel":
      fields("method", "windowId", "initialText", "sourceTabId");
      return {
        method: c.method,
        windowId: windowId(),
        ...(c.initialText !== undefined ? { initialText: text(c.initialText, MAX_TEXT_LENGTH, true) } : {}),
        ...(c.sourceTabId !== undefined ? { sourceTabId: text(c.sourceTabId, MAX_ID_LENGTH) } : {}),
      };
    default:
      return invalid("unknown location command");
  }
}

function requireWindow(s: BrowserState, id: string) {
  const window = s.windows[id];
  if (!window || window.id !== id || (window.incognito ? window.spaceId !== `incognito:${id}` : !s.spaces[window.spaceId]))
    return invalid("window no longer exists");
  return window;
}

function requireStoredTab(s: BrowserState, id: string) {
  const tab = s.tabs[id];
  if (!tab || tab.id !== id || !s.tabLists[tabListKey(s, tab)]?.includes(id)) return invalid("tab no longer exists");
  if (isIncognitoSpace(tab.spaceId)) {
    const window = requireWindow(s, tab.windowId);
    if (!window.incognito || tab.spaceId !== window.spaceId) return invalid("tab does not belong to its private window");
  } else {
    if (!s.spaces[tab.spaceId]) return invalid("tab space no longer exists");
    if (tab.windowId && requireWindow(s, tab.windowId).incognito) return invalid("tab does not belong to its window");
  }
  return tab;
}

function requireTab(s: BrowserState, id: string) {
  const tab = requireStoredTab(s, id);
  const window = requireWindow(s, tab.windowId);
  return { tab, window };
}

/** Synchronous domain execution for local commands and the serialized authority queue. */
export function executeLocationCommand(store: BrowserStore, command: LocationCommand, effects?: LocationCommandEffects): null {
  const s = store.getState();
  const focus = (windowId: string) => {
    store.getState().setFocusedWindow(windowId);
    effects?.focusWindow(windowId);
  };
  switch (command.method) {
    case "openLocation": {
      const { tab, window } = requireTab(s, command.sourceTabId);
      if (command.disposition === "current") s.navigate(tab.id, command.url);
      else if (command.disposition === "backgroundTab") s.newTab(window.id, { url: command.url, spaceId: tab.spaceId, background: true });
      else {
        s.closePanel(window.id);
        if (command.disposition === "newTab")
          store.getState().newTab(window.id, { url: command.url, spaceId: tab.spaceId, openerId: tab.url ? tab.id : undefined });
        else store.getState().createWindow(window.incognito ? { incognito: true, url: command.url } : { spaceId: tab.spaceId, url: command.url });
      }
      break;
    }
    case "switchToExistingTab": {
      const source = requireTab(s, command.sourceTabId);
      const target = requireStoredTab(s, command.targetTabId);
      if (source.window.incognito || isIncognitoSpace(target.spaceId)) {
        if (source.window.id !== target.windowId) return invalid("target tab is outside this private window");
      }
      s.closePanel(source.window.id);
      // Match switchToTab: keep a tab with its page owner, otherwise let the
      // store choose a main window for its shared space list.
      store.getState().activate(target.id, target.windowId || undefined);
      const shown = store.getState().tabs[target.id]!.windowId;
      if (shown && shown !== store.getState().ui.focusedWindowId) focus(shown);
      break;
    }
    case "requestNewTab": {
      const window = requireWindow(s, command.windowId);
      if (command.groupId) {
        const group = s.groups[command.groupId];
        if (!group || group.spaceId !== window.spaceId) return invalid("group does not belong to this window and space");
      }
      const main = window.kind === "small" ? mainWindowFor(s, window.spaceId) : window.id;
      const target = main ?? s.createWindow({ spaceId: window.spaceId });
      if (main) store.getState().openNewTabPanel(target, target === window.id ? command.groupId : undefined);
      else store.getState().openPanel(target);
      if (target !== window.id) focus(target);
      break;
    }
    case "submitNewTab":
      requireWindow(s, command.windowId);
      s.submitNewTabPanel(command.windowId, command.url);
      break;
    case "dismissCommandPanel":
      requireWindow(s, command.windowId);
      s.closePanel(command.windowId);
      break;
    case "openCommandPanel":
      requireWindow(s, command.windowId);
      if (command.sourceTabId !== undefined) {
        const { tab } = requireTab(s, command.sourceTabId);
        if (tab.windowId !== command.windowId) return invalid("source tab belongs to another window");
        // An automatic blank-page request may arrive after navigation, tab switching,
        // or an explicit request that has already opened another panel session.
        if (activeTabId(s, command.windowId) !== tab.id || tab.url || s.windowUi[command.windowId]?.panel.open) break;
      }
      s.openPanel(command.windowId, command.initialText);
      break;
  }
  return null;
}
