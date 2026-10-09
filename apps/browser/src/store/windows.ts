import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import {
  findLast,
  IDLE_LIVE,
  incognitoSpaceId,
  inPinnedContainer,
  isIncognitoSpace,
  makeTab,
  navigationTo,
  newId,
  pinnedFirst,
  pinnedPage,
  resolveWindowId,
  sharesProfile,
  snapshotTab,
  viewTabIds,
  without,
} from "./model";
import { orderSections, syncGroupOrder } from "./groups";
import { mirrorsPins, pinKeyOf, pinsHeldElsewhere } from "./mirroredPins";
import { restoringGroup } from "./organize";
import { adoptParkedPins, atPin, parkWindowPins } from "./parkedPins";
import { isSmall, isSmallWindow, mainWindowFor, littleBayProfile } from "./small";
import { activated, apply, removeTabs, withNewTab } from "./tabs";
import type { BrowserWindow, ClosedTab, ClosedWindow, Frame, ParkedPins, Tab, TabGroup } from "./types";
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
  small?: boolean;
  // Opened behind: the focused window keeps focus.
  background?: boolean;
};

export type WindowsSlice = {
  windows: Record<string, BrowserWindow>;
  windowOrder: string[];
  closedWindows: ClosedWindow[];
  parkedPins: Record<string, ParkedPins>;

  createWindow(options?: CreateWindowOptions): string;
  closeWindow(id: string): void;
  setWindowFrame(id: string, frame: Frame): void;
  toggleSidebar(windowId: string): void;
  switchSpace(windowId: string, spaceId: string): void;
  moveTabsToWindow(tabIds: string[], windowId: string | null): string | undefined;
  moveTabToSpace(tabId: string, spaceId: string): void;
  mergeAllWindows(windowId: string): void;
  reopenClosed(windowId?: string | null): void;
  reopenClosedTab(windowId?: string | null): void;
  reopenClosedWindow(): void;
  restoreClosed(entryId: string, windowId?: string | null): void;
};

function emptyWindow(id: string, spaceId: string, incognito: boolean, frame: Frame | null = null): BrowserWindow {
  return { id, spaceId, incognito, tabIds: [], activeTabIds: {}, sidebarOpen: true, frame, createdAt: Date.now() };
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

export function moveTabsInto(s: BrowserState, ids: string[], targetId: string): BrowserState {
  const target = s.windows[targetId];
  if (!target || isSmallWindow(target)) return s;
  const moving = ids
    .map((id) => s.tabs[id])
    .filter((t): t is Tab => !!t && t.windowId !== targetId && !isIncognitoSpace(t.spaceId) && !target.incognito);
  if (!moving.length) return s;

  // A pin is every window's (store/mirroredPins.ts). Moved out of a window that stays, it leaves its tab there,
  // unloaded. Moved into a window with a tab for it: an unloaded one is dropped, an open one takes the place of an
  // unloaded tab there, and two open ones stay both, the moved one as a page.
  const movingIds = new Set(moving.map((t) => t.id));
  const open = (t: Tab) => !!t.navigation || !!t.adoptId;
  const leftBehind = new Map<string, Tab>();
  for (const t of moving) {
    const src = s.windows[t.windowId];
    if (!pinnedPage(t) || !mirrorsPins(src) || src!.tabIds.every((id) => movingIds.has(id))) continue;
    const { adoptId: _a, wakeAdoptId: _w, ...rest } = t;
    leftBehind.set(t.id, { ...rest, ...atPin(t, s.history[t.spaceId] ?? []), id: newId("tab"), pinKey: pinKeyOf(t), navigation: null, unloaded: true });
  }
  const theirs = new Map<string, Tab>();
  if (mirrorsPins(target)) for (const id of target.tabIds) if (s.tabs[id] && pinnedPage(s.tabs[id]!)) theirs.set(pinKeyOf(s.tabs[id]!), s.tabs[id]!);
  const dropped = new Set<string>();
  const replacing = new Map<string, string>();
  const asPages = new Set<string>();
  for (const t of moving) {
    const there = pinnedPage(t) ? theirs.get(pinKeyOf(t)) : undefined;
    if (!there) continue;
    if (!open(t)) dropped.add(t.id);
    else if (!open(there)) replacing.set(there.id, t.id);
    else asPages.add(t.id);
  }

  const sources = new Set(moving.map((t) => t.windowId));
  let next = removeTabs(s, [...movingIds, ...replacing.keys()], false);
  if (leftBehind.size) {
    const tabs = { ...next.tabs };
    const live = { ...next.live };
    const windows = { ...next.windows };
    for (const id of sources) {
      const src = windows[id];
      if (!src) continue;
      const kept = new Set(src.tabIds);
      const tabIds = s.windows[id]!.tabIds.flatMap((t) => {
        const copy = leftBehind.get(t);
        if (!copy) return kept.has(t) ? [t] : [];
        tabs[copy.id] = copy;
        live[copy.id] = IDLE_LIVE;
        return [copy.id];
      });
      windows[id] = { ...src, tabIds };
    }
    next = { ...next, tabs, live, windows };
  }
  const w = next.windows[targetId]!;
  const tabs = { ...next.tabs };
  const live = { ...next.live };
  const activeTabIds = { ...w.activeTabIds };
  const replaced = new Map([...replacing].map(([there, id]) => [id, there]));
  const kept = moving.filter((t) => !dropped.has(t.id));
  for (const { adoptId, ...t } of kept) {
    const loaded = !!t.url && (!!t.navigation || !!adoptId);
    const { folderId, pinKey, pinnedRow, ...rest } = t;
    const moved: Tab = { ...rest, windowId: targetId, navigation: loaded ? navigationTo(t.url) : null };
    if (asPages.has(t.id)) Object.assign(moved, { pinned: false, pinnedUrl: null });
    else if (pinnedRow) {
      // A pinned row stays one, in the target's folder for its folder if it has one.
      const there = replaced.has(t.id) ? s.tabs[replaced.get(t.id)!] : undefined;
      const folder = folderId ? s.pinnedFolders[folderId] : undefined;
      const key = folder ? (folder.key ?? folder.id) : undefined;
      const local = there?.folderId ?? Object.values(next.pinnedFolders).find((f) => f.windowId === targetId && f.spaceId === t.spaceId && (f.key ?? f.id) === key)?.id;
      Object.assign(moved, { pinnedRow: true }, local ? { folderId: local } : {});
    }
    if (pinKey && !asPages.has(t.id)) moved.pinKey = pinKey;
    tabs[t.id] = moved;
    live[t.id] = IDLE_LIVE;
    activeTabIds[t.spaceId] ??= t.id;
  }
  // Where the target had it, the moved tab takes its place; the rest go after its tabs.
  const present = new Set(w.tabIds);
  const order = s.windows[targetId]!.tabIds.flatMap((id) => (replacing.has(id) ? [replacing.get(id)!] : present.has(id) ? [id] : []));
  const placed = new Set(order);
  const tabIds = [...order, ...w.tabIds.filter((id) => !placed.has(id)), ...kept.map((t) => t.id).filter((id) => !placed.has(id))];
  const window = { ...w, tabIds: orderSections(tabIds, tabs, next.groups), activeTabIds };
  next = {
    ...next,
    tabs,
    live,
    windows: { ...next.windows, [targetId]: window },
    groups: syncGroupOrder(next.groups, window),
  };
  for (const id of sources) {
    const src = next.windows[id];
    if (!src || viewTabIds(next, id).length) continue;
    const recent = src.tabIds.map((t) => next.tabs[t]!).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (recent) next = apply(next, activated(next, src.activeTabIds[recent.spaceId] ?? recent.id));
  }
  return next;
}

function restoreGroup(groups: Record<string, TabGroup>, g: Omit<TabGroup, "tabIds">, tabIds: string[]) {
  const id = groups[g.id] ? newId("g") : g.id;
  return { ...groups, [id]: { ...g, id, tabIds } };
}

export const createWindowsSlice: StateCreator<BrowserState, [], [], WindowsSlice> = (set, get) => ({
  windows: {},
  windowOrder: [],
  closedWindows: [],
  parkedPins: {},

  createWindow(o = {}) {
    const s = get();
    const id = newId("w");
    const small = !!o.small && !o.incognito;
    const spaceId = o.incognito
      ? incognitoSpaceId(id)
      : o.spaceId && s.spaces[o.spaceId]
        ? o.spaceId
        : small
          ? littleBayProfile(s)
          : s.settings.defaultSpaceId;
    let next = withWindow(s, small ? smallWindow(id, spaceId) : emptyWindow(id, spaceId, !!o.incognito, o.frame ?? null));
    if (o.tabIds?.length && !small) next = moveTabsInto(next, o.tabIds, id);
    if (!next.windows[id]!.tabIds.length) next = withNewTab(next, id, { url: o.url, adoptId: o.adoptId })[0];
    const first = next.windows[id]!.tabIds[0]!;
    const shown = next.windows[id]!.activeTabIds[next.tabs[first]!.spaceId] ?? first;
    if (!small) next = adoptParkedPins(next, id, next.tabs[shown]!.spaceId);
    next = apply(next, activated(next, shown));
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
    const tabs = w.tabIds.map((t) => s.tabs[t]).filter((t): t is Tab => !!t && !inPinnedContainer(s, t.id));
    const tabIds = tabs.map((t) => t.id);
    const small = isSmallWindow(w);
    let closedWindows = s.closedWindows;
    if (!w.incognito && !small && tabs.some((t) => t.url)) {
      const active = new Set(Object.values(w.activeTabIds));
      const entry: ClosedWindow = {
        kind: "window",
        id: newId("cw"),
        window: { spaceId: w.spaceId, sidebarOpen: w.sidebarOpen, frame: w.frame },
        // A tab with a page keeps its id: the engine holds its back/forward list under it (NoteClosedTabState).
        tabs: tabs.map((t) => ({ ...snapshotTab(t), active: active.has(t.id), ...(t.url && (t.navigation || t.adoptId) ? { tabId: t.id } : {}) })),
        groups: Object.values(s.groups)
          .filter((g) => g.windowId === id && !g.pinned)
          .map(({ tabIds: members, windowId: _, ...g }) => ({ ...g, tabIndexes: members.map((t) => tabIds.indexOf(t)) })),
        closedAt: Date.now(),
      };
      closedWindows = [...closedWindows, entry].slice(-MAX_CLOSED_WINDOWS);
    }
    // A Little Bay page goes to Recently Closed as a tab, so ⇧⌘T brings it back in Little Bay.
    const next = removeTabs(s, w.tabIds, small);
    set({
      ...next,
      windows: without(next.windows, [id]),
      windowOrder: next.windowOrder.filter((w) => w !== id),
      windowUi: without(next.windowUi, [id]),
      closedWindows,
      // The pins another window has stay there; only the rest are parked for the next window.
      parkedPins: small ? s.parkedPins : parkWindowPins(s.parkedPins, w, s, pinsHeldElsewhere(s, id)),
      closedTabs: w.incognito ? next.closedTabs.filter((c) => c.windowId !== id) : next.closedTabs,
      ui: {
        ...next.ui,
        focusOrder: next.ui.focusOrder.filter((f) => f !== id),
        focusedWindowId: next.ui.focusedWindowId === id ? (next.ui.focusOrder.find((f) => f !== id) ?? null) : next.ui.focusedWindowId,
      },
    });
  },

  setWindowFrame(id, frame) {
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
    s = adoptParkedPins(s, windowId, spaceId);
    const remembered = w.activeTabIds[spaceId];
    let target = remembered && s.tabs[remembered]?.windowId === windowId ? remembered : undefined;
    target ??= s.windows[windowId]!.tabIds.find((id) => s.tabs[id]?.spaceId === spaceId && !s.tabs[id]!.unloaded);
    if (!target) [s, target] = withNewTab(s, windowId, { spaceId, background: true });
    // A favourite remembered here but opened since in another space with this profile comes back to this one.
    const t = s.tabs[target]!;
    if (t.spaceId !== spaceId && t.pinned && sharesProfile(s, t.spaceId, spaceId)) s = { ...s, tabs: { ...s.tabs, [target]: { ...t, spaceId } } };
    // The window takes this space before the tab's activated: activated keeps a shared favourite in the space on screen.
    if (s.tabs[target]!.spaceId === spaceId) s = { ...s, windows: { ...s.windows, [windowId]: { ...s.windows[windowId]!, spaceId } } };
    set(apply(s, activated(s, target)));
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
    if (last) next = apply(next, activated(next, last));
    set(next);
    return windowId;
  },

  moveTabToSpace(tabId, spaceId) {
    const s = get();
    const tab = s.tabs[tabId];
    const w = tab && s.windows[tab.windowId];
    if (!tab || !w || w.incognito || !s.spaces[spaceId] || tab.spaceId === spaceId) return;
    let next = removeTabs(s, [tabId], false);
    const base = next.windows[w.id] ?? { ...w, tabIds: [], activeTabIds: {} };
    const loaded = !!tab.url && (!!tab.navigation || !!tab.adoptId);
    // A tab moved to another profile reopens from its URL: its live tab belongs to the other profile.
    const { adoptId: _, wakeAdoptId: _w, ...rest } = tab;
    const moved: Tab = { ...rest, spaceId, navigation: loaded ? navigationTo(tab.url) : null, lastActiveAt: Date.now() };
    const tabs = { ...next.tabs, [tabId]: moved };
    const index = Math.min(w.tabIds.indexOf(tabId), base.tabIds.length);
    const tabIds = [...base.tabIds];
    tabIds.splice(index, 0, tabId);
    next = {
      ...next,
      tabs,
      live: { ...next.live, [tabId]: IDLE_LIVE },
      windows: { ...next.windows, [w.id]: { ...base, tabIds: pinnedFirst(tabIds, tabs) } },
      windowOrder: next.windowOrder.includes(w.id) ? next.windowOrder : s.windowOrder,
    };
    set(apply(next, activated(next, tabId)));
  },

  mergeAllWindows(windowId) {
    const s = get();
    const target = s.windows[windowId]?.incognito || isSmallWindow(s.windows[windowId]) ? mainWindowFor(s) : windowId;
    if (!target) return;
    const others = s.windowOrder.filter((id) => id !== target && !s.windows[id]?.incognito && !isSmallWindow(s.windows[id]));
    const tabIds = others.flatMap((id) => s.windows[id]!.tabIds);
    if (!tabIds.length) return;
    let next = moveTabsInto(s, tabIds, target);
    const groups = { ...s.groups };
    for (const g of Object.values(s.groups)) if (others.includes(g.windowId)) groups[g.id] = { ...g, windowId: target };
    next = { ...next, groups };
    set(next);
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

function restoreTab(s: BrowserState, entry: ClosedTab, requested?: string | null): BrowserState {
  const owner = entry.tab.spaceId;
  if (entry.pinnedTile && entry.tabId && !s.tabs[entry.tabId] && s.parkedPins[owner]?.tabs.some((p) => p.id === entry.tabId)) {
    const target = resolveWindowId(s, requested);
    let windowId = target && !s.windows[target]!.incognito && s.windows[target]!.spaceId === owner ? target : undefined;
    let next = s;
    if (!windowId) {
      windowId = newId("w");
      next = withWindow(next, emptyWindow(windowId, owner, false));
    }
    next = adoptParkedPins(next, windowId, owner);
    if (next.tabs[entry.tabId]) return restoreTab(next, entry, windowId);
  }
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
  const tile = entry.pinnedTile && entry.tabId ? s.tabs[entry.tabId] : undefined;
  if (tile) {
    const unloaded = !tile.navigation && !tile.adoptId;
    const tabs = unloaded
      ? { ...s.tabs, [tile.id]: { ...tile, url: entry.tab.url, title: entry.tab.title, favicon: entry.tab.favicon, muted: entry.tab.muted, adoptId: restoreId(tile.id) } }
      : s.tabs;
    const next: BrowserState = { ...s, closedTabs, tabs };
    return apply(next, activated(next, tile.id));
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
    index: w.id === entry.windowId ? entry.index : undefined,
    adoptId: entry.tabId && entry.tab.url ? restoreId(entry.tabId) : undefined,
  });
  next = withTab;
  const g = entry.group;
  if (g) {
    const existing = next.groups[g.id];
    if (existing && existing.windowId === windowId && existing.spaceId === spaceId) {
      next = { ...next, groups: { ...next.groups, [g.id]: { ...existing, tabIds: [...existing.tabIds, tabId] } } };
    } else if (!existing) {
      next = { ...next, groups: restoreGroup(next.groups, { ...g, windowId, spaceId, collapsed: false, pinned: false, createdAt: Date.now() }, [tabId]) };
    }
  }
  return next;
}

function restoreWindow(s: BrowserState, entry: ClosedWindow): BrowserState {
  const id = newId("w");
  const profileOk = (p: string) => (s.spaces[p] ? p : s.settings.defaultSpaceId);
  const w = emptyWindow(id, profileOk(entry.window.spaceId), false, entry.window.frame);
  w.sidebarOpen = entry.window.sidebarOpen;
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  const ids: string[] = [];
  for (const { active, tabId, ...snap } of entry.tabs) {
    const t = makeTab(id, profileOk(snap.spaceId), "", { ...snap, spaceId: profileOk(snap.spaceId) });
    if (tabId && snap.url) t.wakeAdoptId = restoreId(tabId);
    tabs[t.id] = t;
    live[t.id] = IDLE_LIVE;
    ids.push(t.id);
    if (active || !w.activeTabIds[t.spaceId]) w.activeTabIds[t.spaceId] = t.id;
  }
  w.tabIds = pinnedFirst(ids, tabs);
  let groups = s.groups;
  for (const { tabIndexes, ...g } of entry.groups) {
    const members = tabIndexes.map((i) => ids[i]).filter((t): t is string => !!t);
    if (members.length) groups = restoreGroup(groups, { ...g, windowId: id }, members);
  }
  let next = withWindow({ ...s, tabs, live, groups, closedWindows: s.closedWindows.filter((c) => c.id !== entry.id) }, w);
  const shown = w.activeTabIds[w.spaceId] ?? w.tabIds[0]!;
  next = adoptParkedPins(next, id, w.spaceId);
  next = apply(next, activated(next, shown));
  return next;
}
