import { capabilities } from "@bay/platform";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { orderSections, syncGroupOrder, leaveGroups } from "./groups";
import {
  findLast,
  IDLE_LIVE,
  incognitoSpaceId,
  isIncognitoSpace,
  listIds,
  makeTab,
  navigationTo,
  newId,
  pinnedFirst,
  resolveWindowId,
  sharesProfile,
  spaceListKey,
  tabListKey,
  tabToShow,
  windowListKey,
  windowTabIds,
  withList,
  without,
} from "./model";
import { restoringGroup } from "./organize";
import { isSmall, isSmallWindow, mainWindowFor, littleBayProfile } from "./small";
import { removeFromSplits } from "./splits";
import { activated, apply, removeTabs, successors, withNewTab } from "./tabs";
import type { BrowserWindow, ClosedTab, ClosedWindow, Frame, Tab, TabGroup, WindowPlacement, WindowSize } from "./types";
import { nativeWindowPlacement, restoredWindowPlacement, validWindowSize } from "./windowPlacement";
import { MAX_CLOSED_WINDOWS } from "./constants";

// A closed tab's back/forward list is Chrome's (TabRestoreService), which the engine finds by the closed tab's id.
const restoreId = (tabId: string) => `restore:${tabId}`;

export type CreateWindowOptions = {
  spaceId?: string;
  incognito?: boolean;
  url?: string;
  adoptId?: string;
  tabIds?: string[];
  frame?: Frame | null;
  size?: WindowPlacement["size"];
  maximized?: boolean;
  small?: boolean;
  // Opened behind: the focused window keeps focus.
  background?: boolean;
};

export type WindowsSlice = {
  windows: Record<string, BrowserWindow>;
  windowOrder: string[];
  closedWindows: ClosedWindow[];

  createWindow(options?: CreateWindowOptions): string;
  /** The window goes; its tabs stay their space's, their pages unloaded (as Arc's). A private window's tabs and a
   *  Little Bay's page go with it. */
  closeWindow(id: string): void;
  setWindowFrame(id: string, frame: Frame): void;
  setWindowPlacement(id: string, placement: WindowPlacement): void;
  toggleSidebar(windowId: string): void;
  switchSpace(windowId: string, spaceId: string): void;
  /** Shows the tabs in the window (a new one for null): their pages move there. */
  moveTabsToWindow(tabIds: string[], windowId: string | null): string | undefined;
  moveTabToSpace(tabId: string, spaceId: string): void;
  /** The other main windows close; their pages move into this one. */
  mergeAllWindows(windowId: string): void;
  reopenClosed(windowId?: string | null): void;
  reopenClosedTab(windowId?: string | null): void;
  reopenClosedWindow(): void;
  restoreClosed(entryId: string, windowId?: string | null): void;
};

function emptyWindow(id: string, spaceId: string, incognito: boolean, frame: Frame | null = null): BrowserWindow {
  return { id, spaceId, incognito, activeTabIds: {}, sidebarOpen: true, frame, createdAt: Date.now() };
}

// Little Bay opens centred at its remembered size (packages/shell Windows.swift), so it keeps no frame.
const smallWindow = (id: string, spaceId: string): BrowserWindow => ({ ...emptyWindow(id, spaceId, false), sidebarOpen: false, kind: "small" });

function withWindow(s: BrowserState, w: BrowserWindow): BrowserState {
  return {
    ...s,
    windows: { ...s.windows, [w.id]: w },
    windowOrder: [...s.windowOrder, w.id],
    ui: { ...s.ui, focusedWindowId: w.id, focusOrder: [w.id, ...s.ui.focusOrder] },
  };
}

function withoutWindows(s: BrowserState, ids: string[]): BrowserState {
  if (!ids.length) return s;
  return {
    ...s,
    windows: without(s.windows, ids),
    windowOrder: s.windowOrder.filter((w) => !ids.includes(w)),
    windowUi: without(s.windowUi, ids),
    ui: {
      ...s.ui,
      focusOrder: s.ui.focusOrder.filter((f) => !ids.includes(f)),
      focusedWindowId:
        s.ui.focusedWindowId && ids.includes(s.ui.focusedWindowId) ? (s.ui.focusOrder.find((f) => !ids.includes(f)) ?? null) : s.ui.focusedWindowId,
    },
  };
}

/** The tab's page moves to the window (lib/tabPages.ts hands it over); a loaded one loads there. */
function pageTo(t: Tab, windowId: string): Tab {
  if (t.windowId === windowId) return t;
  const { adoptId, ...rest } = t;
  const loaded = !!t.url && (!!t.navigation || !!adoptId);
  return { ...rest, windowId, navigation: loaded ? navigationTo(t.url) : null };
}

/**
 * The window shows these tabs: their pages move there, and a window that showed one of them shows another. A Little
 * Bay page moves into its space's list (Little Bay goes).
 */
export function moveTabsInto(s: BrowserState, ids: string[], targetId: string): BrowserState {
  const target = s.windows[targetId];
  if (!target || isSmallWindow(target)) return s;
  const moving = ids
    .map((id) => s.tabs[id])
    .filter(
      (t): t is Tab =>
        !!t && t.windowId !== targetId && isIncognitoSpace(t.spaceId) === target.incognito && (!target.incognito || t.spaceId === target.spaceId),
    );
  if (!moving.length) return s;
  const movingIds = new Set(moving.map((t) => t.id));

  // A Little Bay page leaves its window for its space's list, at the list's end.
  const littles = moving.filter((t) => isSmallWindow(s.windows[t.windowId]));
  let next = s;
  for (const t of littles) {
    const key = spaceListKey(next, t.spaceId);
    const tabs = { ...next.tabs, [t.id]: { ...t, windowId: "" } };
    next = withList(withList({ ...next, tabs }, { key: t.windowId, tabIds: listIds(next, t.windowId).filter((id) => id !== t.id) }), {
      key,
      tabIds: pinnedFirst([...listIds(next, key), t.id], tabs),
    });
  }
  next = withoutWindows(
    next,
    littles.map((t) => t.windowId).filter((w) => !next.tabLists[w]),
  );

  const tabs = { ...next.tabs };
  for (const t of moving) tabs[t.id] = pageTo(next.tabs[t.id]!, targetId);
  const windows = { ...next.windows };
  for (const w of Object.values(next.windows)) {
    if (w.id === targetId || !Object.values(w.activeTabIds).some((id) => movingIds.has(id))) continue;
    windows[w.id] = { ...w, activeTabIds: successors(next, w, movingIds) };
  }
  const t = windows[targetId]!;
  const activeTabIds = { ...t.activeTabIds };
  for (const m of moving) activeTabIds[m.spaceId] ??= m.id;
  windows[targetId] = { ...t, activeTabIds };
  next = { ...next, tabs, windows, live: { ...next.live, ...Object.fromEntries(moving.map((m) => [m.id, next.live[m.id] ?? IDLE_LIVE])) } };
  // A window whose tab moved shows its next one, woken.
  for (const w of Object.values(next.windows)) {
    const shown = w.activeTabIds[w.spaceId];
    if (w.id !== targetId && shown && s.windows[w.id]?.activeTabIds[w.spaceId] !== shown) next = apply(next, activated(next, shown, w.id));
  }
  return next;
}

export const createWindowsSlice: StateCreator<BrowserState, [], [], WindowsSlice> = (set, get) => ({
  windows: {},
  windowOrder: [],
  closedWindows: [],

  createWindow(o = {}) {
    const s = get();
    const id = newId("w");
    const small = !!o.small && !o.incognito;
    const spaceId = o.incognito ? incognitoSpaceId(id) : o.spaceId && s.spaces[o.spaceId] ? o.spaceId : small ? littleBayProfile(s) : s.settings.defaultSpaceId;
    const global = capabilities.globalWindowCoordinates;
    const w = emptyWindow(id, spaceId, !!o.incognito, global ? (o.frame ?? null) : null);
    // Without global coordinates a frame contributes only its size.
    Object.assign(w, restoredWindowPlacement(global ? { ...o, frame: null } : o));
    let next = withWindow(s, small ? smallWindow(id, spaceId) : w);
    if (o.tabIds?.length && !small) next = moveTabsInto(next, o.tabIds, id);
    const shown = o.tabIds?.length && !small ? findLast(o.tabIds, (t) => next.tabs[t]?.windowId === id) : undefined;
    if (shown) next = apply(next, activated(next, shown, id));
    else next = withNewTab(next, id, { url: o.url, adoptId: o.adoptId })[0];
    const focused = s.ui.focusedWindowId;
    if (o.background && focused && s.windows[focused]) {
      next = { ...next, ui: { ...next.ui, focusedWindowId: focused, focusOrder: [focused, id, ...s.ui.focusOrder.filter((w) => w !== focused)] } };
    }
    set(next);
    return id;
  },

  closeWindow(id) {
    const s = get();
    const w = s.windows[id];
    if (!w) return;
    const small = isSmallWindow(w);
    let next: BrowserState = s;
    if (w.incognito || small) {
      // A Little Bay page goes to Recently Closed as a tab, so ⇧⌘T brings it back in Little Bay.
      next = removeTabs(s, listIds(s, windowListKey(s, w)), small);
      if (w.incognito) next = { ...next, closedTabs: next.closedTabs.filter((c) => c.windowId !== id) };
    } else {
      // Its pages close with it: each tab waits, unloaded, to come back with its back/forward list (the engine keeps
      // it under the tab's id: NoteClosedTabState) in the next window that shows it.
      const tabs = { ...s.tabs };
      const live = { ...s.live };
      for (const tid of windowTabIds(s, id)) {
        const t = s.tabs[tid]!;
        const { adoptId: _, ...rest } = t;
        const loaded = !!t.url && (!!t.navigation || !!t.adoptId);
        tabs[tid] = { ...rest, windowId: "", navigation: null, unloaded: true, ...(loaded ? { wakeAdoptId: restoreId(tid) } : {}) };
        live[tid] = IDLE_LIVE;
      }
      const entry: ClosedWindow = {
        kind: "window",
        id: newId("cw"),
        window: {
          spaceId: w.spaceId,
          sidebarOpen: w.sidebarOpen,
          frame: null,
          ...nativeWindowPlacement(w),
          shownTabId: w.activeTabIds[w.spaceId],
        },
        tabs: [],
        groups: [],
        closedAt: Date.now(),
      };
      next = { ...s, tabs, live, closedWindows: [...s.closedWindows, entry].slice(-MAX_CLOSED_WINDOWS) };
    }
    set(withoutWindows(next, [id]));
  },

  setWindowFrame(id, frame) {
    if (!capabilities.globalWindowCoordinates) return;
    set((s) => {
      const w = s.windows[id];
      if (!w || (w.frame && w.frame.every((v, i) => v === frame[i]))) return {};
      const windows = { ...s.windows, [id]: { ...w, frame } };
      if (!isSmallWindow(w)) return { windows };
      // Little Bay remembers its size, not its position: it always opens centred.
      const size: [number, number] = [Math.round(frame[2]), Math.round(frame[3])];
      const [width, height] = s.settings.littleBaySize ?? [];
      return size[0] === width && size[1] === height ? { windows } : { windows, settings: { ...s.settings, littleBaySize: size } };
    });
  },

  setWindowPlacement(id, placement) {
    if (capabilities.globalWindowCoordinates) return;
    set((s) => {
      const w = s.windows[id];
      if (!w) return {};
      const size: WindowSize | undefined = validWindowSize(placement.size) ? [...placement.size] : w.size;
      const maximized = typeof placement.maximized === "boolean" ? placement.maximized : w.maximized;
      if (w.frame === null && size?.[0] === w.size?.[0] && size?.[1] === w.size?.[1] && maximized === w.maximized) return {};
      const windows = { ...s.windows, [id]: { ...w, frame: null, ...(size ? { size } : {}), ...(maximized !== undefined ? { maximized } : {}) } };
      if (!isSmallWindow(w) || !size) return { windows };
      return { windows, settings: { ...s.settings, littleBaySize: size } };
    });
  },

  toggleSidebar(windowId) {
    set((s) => {
      const w = s.windows[windowId];
      return w ? { windows: { ...s.windows, [windowId]: { ...w, sidebarOpen: !w.sidebarOpen } } } : {};
    });
  },

  switchSpace(windowId, spaceId) {
    let s = get();
    const w = s.windows[windowId];
    if (!w || w.incognito || isSmallWindow(w) || !s.spaces[spaceId] || w.spaceId === spaceId) return;
    // The tab it showed there last, else the space's most recent one (not one another window shows), else a new one.
    let target = tabToShow(s, windowId, spaceId);
    if (!target) [s, target] = withNewTab(s, windowId, { spaceId, background: true });
    const t = s.tabs[target]!;
    if (t.spaceId !== spaceId && t.pinned && sharesProfile(s, t.spaceId, spaceId)) s = { ...s, tabs: { ...s.tabs, [target]: { ...t, spaceId } } };
    // The window takes this space before the tab's activated: activated keeps a shared favourite in the space on screen.
    s = { ...s, windows: { ...s.windows, [windowId]: { ...s.windows[windowId]!, spaceId } } };
    const next = apply(s, activated(s, target, windowId));
    // The command bar stays open across the switch (activated closes it) and shows the new space's tabs and history;
    // a new tab it was opening goes to the new space, out of the group it was for (the old space's).
    const panel = s.windowUi[windowId]?.panel;
    if (panel?.open) {
      const { groupId: _, ...kept } = panel;
      next.windowUi = { ...next.windowUi, [windowId]: { ...next.windowUi[windowId]!, panel: kept } };
    }
    set(next);
  },

  moveTabsToWindow(tabIds, windowId) {
    const s = get();
    if (windowId === null) {
      const first = s.tabs[tabIds[0] ?? ""];
      if (!first || isIncognitoSpace(first.spaceId)) return undefined;
      return get().createWindow({ spaceId: first.spaceId, tabIds });
    }
    let next = moveTabsInto(s, tabIds, windowId);
    const last = findLast(tabIds, (id) => next.tabs[id]?.windowId === windowId);
    if (last) next = apply(next, activated(next, last, windowId));
    set(next);
    return windowId;
  },

  moveTabToSpace(tabId, spaceId) {
    const s = get();
    const tab = s.tabs[tabId];
    if (!tab || isIncognitoSpace(tab.spaceId) || !s.spaces[spaceId] || tab.spaceId === spaceId) return;
    const from = tabListKey(s, tab);
    const to = spaceListKey(s, spaceId);
    const engine = sharesProfile(s, tab.spaceId, spaceId);
    // It leaves its folder (the other space's). A tab moved to another profile reopens from its URL: its live tab
    // belongs to the other profile.
    const { folderId: _f, ...kept } = tab;
    const { adoptId: _a, wakeAdoptId: _w, ...fresh } = kept;
    const loaded = !!tab.url && (!!tab.navigation || !!tab.adoptId);
    const moved: Tab = engine
      ? { ...kept, spaceId, lastActiveAt: Date.now() }
      : { ...fresh, spaceId, navigation: loaded ? navigationTo(tab.url) : null, lastActiveAt: Date.now() };
    const tabs = { ...s.tabs, [tabId]: moved };
    const windows = { ...s.windows };
    for (const w of Object.values(s.windows))
      if (w.activeTabIds[tab.spaceId] === tabId) windows[w.id] = { ...w, activeTabIds: successors(s, w, new Set([tabId])) };
    let next: BrowserState = {
      ...s,
      tabs,
      windows,
      live: engine ? s.live : { ...s.live, [tabId]: IDLE_LIVE },
      groups: leaveGroups(s.groups, new Set([tabId])),
      splits: removeFromSplits(s.splits, new Set([tabId])),
    };
    const fromList = listIds(next, from).filter((id) => id !== tabId);
    next = withList(next, { key: from, tabIds: fromList });
    const toList = from === to ? fromList : listIds(next, to);
    next = withList(next, { key: to, tabIds: orderSections([tabId, ...toList], tabs, next.groups, next.pinnedFolders) });
    set(apply(next, activated(next, tabId, s.windows[tab.windowId] ? tab.windowId : undefined)));
  },

  mergeAllWindows(windowId) {
    const s = get();
    const target = s.windows[windowId]?.incognito || isSmallWindow(s.windows[windowId]) ? mainWindowFor(s) : windowId;
    if (!target) return;
    const others = s.windowOrder.filter((id) => id !== target && !s.windows[id]?.incognito && !isSmallWindow(s.windows[id]));
    if (!others.length) return;
    const tabs = { ...s.tabs };
    for (const t of Object.values(s.tabs)) if (others.includes(t.windowId)) tabs[t.id] = pageTo(t, target);
    set(withoutWindows({ ...s, tabs }, others));
  },

  reopenClosed(windowId) {
    const s = get();
    const target = resolveWindowId(s, windowId);
    const lastTab = findLast(s.closedTabs, (c) => canRestoreTabInto(s, c, target));
    const lastWindow = s.windows[target ?? ""]?.incognito ? undefined : s.closedWindows.at(-1);
    const lastGroup = s.windows[target ?? ""]?.incognito ? undefined : s.closedGroups.at(-1);
    const entry = [lastWindow, lastGroup, lastTab].reduce<{ id: string; closedAt: number } | undefined>(
      (latest, e) => (e && (!latest || e.closedAt > latest.closedAt) ? e : latest),
      undefined,
    );
    if (entry) get().restoreClosed(entry.id, target);
  },

  reopenClosedTab(windowId) {
    const s = get();
    const target = resolveWindowId(s, windowId);
    const entry = findLast(s.closedTabs, (c) => canRestoreTabInto(s, c, target));
    if (entry) get().restoreClosed(entry.id, target);
  },

  reopenClosedWindow() {
    const entry = get().closedWindows.at(-1);
    if (entry) get().restoreClosed(entry.id);
  },

  restoreClosed(entryId, windowId) {
    const s = get();
    if (isSmall(s, windowId)) windowId = mainWindowFor(s) ?? null;
    const closedTab = s.closedTabs.find((c) => c.id === entryId);
    if (closedTab) return set(restoreTab(s, closedTab, windowId));
    const closedWindow = s.closedWindows.find((c) => c.id === entryId);
    if (closedWindow) return set(restoreWindow(s, closedWindow));
    const closedGroup = s.closedGroups.find((c) => c.id === entryId) ?? s.deletedGroups.find((c) => c.id === entryId);
    if (closedGroup) set(restoringGroup(s, closedGroup, windowId));
  },
});

function canRestoreTabInto(s: BrowserState, c: ClosedTab, windowId: string | undefined): boolean {
  const w = windowId ? s.windows[windowId] : undefined;
  if (isIncognitoSpace(c.tab.spaceId)) return c.windowId === windowId;
  return !w?.incognito;
}

function restoreGroup(groups: Record<string, TabGroup>, g: Omit<TabGroup, "tabIds">, tabIds: string[]) {
  const id = groups[g.id] ? newId("g") : g.id;
  return { ...groups, [id]: { ...g, id, tabIds } };
}

function restoreTab(s: BrowserState, entry: ClosedTab, requested?: string | null): BrowserState {
  const closedTabs = s.closedTabs.filter((c) => c.id !== entry.id);
  if (entry.small && !isIncognitoSpace(entry.tab.spaceId)) {
    const id = newId("w");
    const spaceId = s.spaces[entry.tab.spaceId] ? entry.tab.spaceId : littleBayProfile(s);
    const next = withWindow({ ...s, closedTabs }, smallWindow(id, spaceId));
    return withNewTab(next, id, {
      url: entry.tab.url || undefined,
      spaceId,
      snapshot: { ...entry.tab, pinned: false, spaceId },
      adoptId: entry.tabId && entry.tab.url ? restoreId(entry.tabId) : undefined,
    })[0];
  }
  // A pinned tab closed (unloaded) comes back where it is, with its page.
  const tile = entry.pinnedTile && entry.tabId ? s.tabs[entry.tabId] : undefined;
  if (tile) {
    const unloaded = !tile.navigation && !tile.adoptId;
    const tabs = unloaded
      ? {
          ...s.tabs,
          [tile.id]: { ...tile, url: entry.tab.url, title: entry.tab.title, favicon: entry.tab.favicon, muted: entry.tab.muted, adoptId: restoreId(tile.id) },
        }
      : s.tabs;
    const next: BrowserState = { ...s, closedTabs, tabs };
    return apply(next, activated(next, tile.id, resolveWindowId(next, requested)));
  }
  const original = s.windows[entry.windowId];
  let windowId = original && canRestoreTabInto(s, entry, original.id) ? original.id : resolveWindowId(s, requested);
  let next: BrowserState = { ...s, closedTabs };
  if (!windowId || !canRestoreTabInto(s, entry, windowId)) {
    if (isIncognitoSpace(entry.tab.spaceId)) return next;
    windowId = newId("w");
    next = withWindow(next, emptyWindow(windowId, s.spaces[entry.tab.spaceId] ? entry.tab.spaceId : s.settings.defaultSpaceId, false));
  }
  const w = next.windows[windowId]!;
  const spaceId = isIncognitoSpace(entry.tab.spaceId) || s.spaces[entry.tab.spaceId] ? entry.tab.spaceId : w.spaceId;
  const [withTab, tabId] = withNewTab(next, windowId, {
    url: entry.tab.url || undefined,
    spaceId,
    snapshot: entry.tab,
    // Where it was in its list, if it's back in it.
    index: spaceId === entry.tab.spaceId ? entry.index : undefined,
    adoptId: entry.tabId && entry.tab.url ? restoreId(entry.tabId) : undefined,
  });
  next = withTab;
  const g = entry.group;
  if (g) {
    const existing = next.groups[g.id];
    if (existing && existing.spaceId === spaceId) {
      next = { ...next, groups: { ...next.groups, [g.id]: { ...existing, tabIds: [...existing.tabIds, tabId] } } };
    } else if (!existing) {
      next = { ...next, groups: restoreGroup(next.groups, { ...g, spaceId, collapsed: false, pinned: false, createdAt: Date.now() }, [tabId]) };
    }
    const list = { key: tabListKey(next, next.tabs[tabId]!), tabIds: listIds(next, tabListKey(next, next.tabs[tabId]!)) };
    next = { ...next, groups: syncGroupOrder(next.groups, list) };
  }
  return next;
}

// A closed window comes back where it was, on its space. One a launch closed (settings.restoreSession) brings its tabs.
function restoreWindow(s: BrowserState, entry: ClosedWindow): BrowserState {
  const id = newId("w");
  const spaceOk = (p: string) => (s.spaces[p] ? p : s.settings.defaultSpaceId);
  const w = emptyWindow(id, spaceOk(entry.window.spaceId), false, capabilities.globalWindowCoordinates ? entry.window.frame : null);
  Object.assign(w, restoredWindowPlacement(entry.window));
  w.sidebarOpen = entry.window.sidebarOpen;
  // What it showed, as it showed it (tabToShow takes it while it's still the space's and no other window shows it).
  if (entry.window.shownTabId && s.tabs[entry.window.shownTabId]) w.activeTabIds[w.spaceId] = entry.window.shownTabId;
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  const added: Record<string, string[]> = {};
  const ids: string[] = [];
  for (const { active, tabId, ...snap } of entry.tabs) {
    const t = makeTab(id, spaceOk(snap.spaceId), "", { ...snap, spaceId: spaceOk(snap.spaceId) });
    if (tabId && snap.url) t.wakeAdoptId = restoreId(tabId);
    tabs[t.id] = t;
    live[t.id] = IDLE_LIVE;
    ids.push(t.id);
    const key = spaceListKey(s, t.spaceId);
    (added[key] ??= []).push(t.id);
    if (active || !w.activeTabIds[t.spaceId]) w.activeTabIds[t.spaceId] = t.id;
  }
  let next = withWindow({ ...s, tabs, live, closedWindows: s.closedWindows.filter((c) => c.id !== entry.id) }, w);
  for (const [key, list] of Object.entries(added)) next = withList(next, { key, tabIds: pinnedFirst([...listIds(next, key), ...list], tabs) });
  let groups = next.groups;
  for (const { tabIndexes, ...g } of entry.groups) {
    const members = tabIndexes.map((i) => ids[i]).filter((t): t is string => !!t);
    if (members.length) groups = restoreGroup(groups, g, members);
  }
  next = { ...next, groups };
  // Its space's tabs are there already: it shows the most recent one no other window shows, else a new tab.
  const shown = tabToShow(next, id, w.spaceId);
  return shown ? apply(next, activated(next, shown, id)) : withNewTab(next, id)[0];
}
