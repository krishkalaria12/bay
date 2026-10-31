import { toAppUrl } from "@bay/core";
import type { BrowserState, BrowserStore } from "../store/browser";
import { MAX_SPLIT_PANES } from "../store/constants";
import { activeTabId, engineProfileFor, isIncognitoSpace, tabListKey } from "../store/model";
import { opensInPeek } from "../store/peeks";
import { splitOf } from "../store/splits";
import type { BrowserWindow, Tab } from "../store/types";

export type PageOpen = {
  offerId: string;
  sourceTabId?: string;
  sourceWindowId: string;
  sourceProfile: string;
  profile: string;
  incognito: boolean;
  url: string;
  disposition: "current" | "foreground" | "background" | "window" | "incognito" | "split";
};

const fields = ["offerId", "sourceTabId", "sourceWindowId", "sourceProfile", "profile", "incognito", "url", "disposition"];
const invalid = (): never => {
  throw new Error("invalid native page open");
};
function text(value: unknown, limit = 1024, empty = false): string {
  return typeof value === "string" && value.length <= limit && (empty || !!value.trim()) ? value : invalid();
}

/** This envelope comes only from Chrome. User commands cannot carry native page offers. */
export function parsePageOpen(input: unknown): PageOpen {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !fields.includes(key))) return invalid();
  const offerId = text(value.offerId);
  if (!/^bay-tab:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(offerId)) return invalid();
  const disposition = value.disposition;
  if (!["current", "foreground", "background", "window", "incognito", "split"].includes(text(disposition)) || typeof value.incognito !== "boolean")
    return invalid();
  return {
    offerId,
    ...(value.sourceTabId === undefined ? {} : { sourceTabId: text(value.sourceTabId) }),
    sourceWindowId: text(value.sourceWindowId),
    sourceProfile: text(value.sourceProfile, 1024, true),
    profile: text(value.profile, 1024, true),
    incognito: value.incognito,
    url: toAppUrl(text(value.url, 1_048_576)),
    disposition: disposition as PageOpen["disposition"],
  };
}

function windowFor(s: BrowserState, id: string): BrowserWindow | undefined {
  const w = Object.hasOwn(s.windows, id) ? s.windows[id] : undefined;
  return w?.id === id && (w.incognito ? w.spaceId === `incognito:${id}` : Object.hasOwn(s.spaces, w.spaceId)) ? w : undefined;
}

function sourceFor(s: BrowserState, event: PageOpen): { window: BrowserWindow; spaceId: string; tab?: Tab } | undefined {
  if (event.sourceTabId) {
    const tab = Object.hasOwn(s.tabs, event.sourceTabId) ? s.tabs[event.sourceTabId] : undefined;
    if (!tab || tab.id !== event.sourceTabId || tab.unloaded || engineProfileFor(tab.spaceId, s.spaces) !== event.sourceProfile) return;
    // A queued native offer follows its opener after a window handoff.
    const window = windowFor(s, tab.windowId);
    if (!window || (window.incognito ? tab.spaceId !== window.spaceId : isIncognitoSpace(tab.spaceId) || !Object.hasOwn(s.spaces, tab.spaceId))) return;
    if (!s.tabLists[tabListKey(s, tab)]?.includes(tab.id) && s.peeks[window.id]?.tabId !== tab.id) return;
    return { window, tab, spaceId: tab.spaceId };
  }
  const window = windowFor(s, event.sourceWindowId);
  if (!window) return;
  if (window.incognito) return engineProfileFor(window.spaceId, s.spaces) === event.sourceProfile ? { window, spaceId: window.spaceId } : undefined;
  const spaceId = [window.spaceId, ...s.spaceOrder].find((id) => Object.hasOwn(s.spaces, id) && engineProfileFor(id, s.spaces) === event.sourceProfile);
  return spaceId ? { window, spaceId } : undefined;
}

export type PageOpenEffects = { focusWindow?(windowId: string): void };

/** Assigns a browser-owned page to the authority's model without reloading its URL. */
export function applyPageOpen(store: BrowserStore, event: PageOpen, effects?: PageOpenEffects): string | null {
  const s = store.getState();
  const accepted = Object.values(s.tabs).find((tab) => tab.adoptId === event.offerId || tab.wakeAdoptId === event.offerId);
  if (accepted) return accepted.id;
  const source = sourceFor(s, event);
  if (!source) return null;
  const { window, spaceId, tab } = source;
  const newPrivate = event.disposition === "incognito" || (event.disposition === "window" && window.incognito);
  // A new private window always has its own session; a private opener's offered page cannot move there.
  const freshPrivate = newPrivate && window.incognito;
  const adoptPrivate = newPrivate && !window.incognito && event.incognito;
  if (event.profile !== event.sourceProfile || (!freshPrivate && !adoptPrivate && event.incognito !== window.incognito)) return null;
  const focus = (id: string | null, foreground: boolean): string | null => {
    if (!id) return null;
    const target = store.getState().tabs[id]?.windowId;
    if (foreground && target && target !== window.id) {
      store.getState().setFocusedWindow(target);
      effects?.focusWindow?.(target);
    }
    return id;
  };
  // Current-tab navigations already happen in Chrome and arrive as page facts;
  // they must never replace a live transfer key with another offered page.
  if (event.disposition === "current") return null;
  if (newPrivate) {
    // Native publication claims this exact offered OTR profile for the generated private window.
    const id = s.createWindow({ incognito: true, url: event.url, ...(adoptPrivate ? { adoptId: event.offerId } : {}) });
    return focus(activeTabId(store.getState(), id) ?? null, true);
  }
  if (event.disposition === "window") {
    const id = s.createWindow({ spaceId, url: event.url, adoptId: event.offerId });
    return focus(activeTabId(store.getState(), id) ?? null, true);
  }
  // Little Bay keeps its page. Its new tabs and splits open behind it in a main window.
  if (window.kind === "small") return s.newTab(window.id, { spaceId, url: event.url, adoptId: event.offerId, openerId: tab?.id, background: true }) || null;
  if (event.disposition === "split") {
    if (tab) {
      const split = splitOf(s, tab.id);
      const next = split?.tabIds[split.tabIds.indexOf(tab.id) + 1];
      if (split && (next || split.tabIds.length >= MAX_SPLIT_PANES)) {
        const target = next ?? split.tabIds.at(-1)!;
        if (target !== tab.id) {
          const before = activeTabId(s, window.id);
          const id = s.newTab(window.id, { spaceId, url: event.url, adoptId: event.offerId, openerId: tab.id, background: true });
          store.getState().replaceSplitPane(target, id);
          if (before && before !== target) store.getState().activate(before);
          return id;
        }
      }
    }
    const result = s.openSplitPane(window.id, {
      ...(tab ? { anchorTabId: tab.id, side: "right", background: true } : {}),
      url: event.url,
      adoptId: event.offerId,
    });
    return result.ok ? result.tabId : null;
  }
  if (event.disposition === "foreground" && tab && opensInPeek(s, tab.id, event.url)) return s.openPeek(tab.id, event.url, event.offerId) ?? null;
  return focus(
    s.newTab(window.id, { spaceId, url: event.url, adoptId: event.offerId, openerId: tab?.id, background: event.disposition === "background" }) || null,
    event.disposition === "foreground",
  );
}
