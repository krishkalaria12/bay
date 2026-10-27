import { resolveInput } from "@bay/core";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { leaveGroups, orderSections, syncGroupOrder } from "./groups";
import {
  activeTabId,
  closesWindow,
  IDLE_LIVE,
  inPinnedContainer,
  makeTab,
  merge,
  navigationTo,
  newId,
  isIncognitoSpace,
  listIds,
  listOfTab,
  pinnedFirst,
  pinnedPage,
  sharesProfile,
  snapshotTab,
  spaceListKey,
  tabListKey,
  viewTabIds,
  windowListKey,
  withList,
  wake,
  without,
} from "./model";
import { forgetOpeners, insertionIndex, openerSuccessor, switchKeepsOpeners } from "./openers";
import { groupWithOpener, onUrlChange, pruneSelection, samePage } from "./organize";
import { searchUrlPrefix } from "./settings";
import { mainWindowFor } from "./small";
import { tabEngine, typedNavigationEngine } from "./engines";
import { removeFromSplits, splitOf } from "./splits";
import type { BrowserWindow, ClosedTab, Tab, TabLive, TabSnapshot } from "./types";
import { MAX_CLOSED_TABS } from "./constants";

export type NewTabOptions = {
  url?: string;
  background?: boolean;
  adoptId?: string;
  openerId?: string;
  spaceId?: string;
  pinned?: boolean;
  snapshot?: Partial<TabSnapshot>;
  index?: number;
  // Load only when first shown, adopting this (a restored tab: "restore:<id>").
  wakeAdoptId?: string;
};

let openOutsideTab: (url: string, windowId: string) => boolean = () => false;
export const setAppUrlOpener = (open: typeof openOutsideTab) => {
  openOutsideTab = open;
};

export type TabsSlice = {
  tabs: Record<string, Tab>;
  // Each list's tabs in sidebar order, by store/model.ts tabListKey: a profile's (its spaces'), a private window's, a
  // Little Bay's.
  tabLists: Record<string, string[]>;
  live: Record<string, TabLive>;
  closedTabs: ClosedTab[];

  newTab(windowId: string, options?: NewTabOptions): string;
  closeTab(id: string): void;
  closeTabs(ids: string[]): void;
  // Removes the tab from its list even when it's pinned (a closed pinned row's ×); Reopen Closed Tab brings it back.
  removeTab(id: string): void;
  /** Shows the tab: in `windowId`, else the window store/tabs.ts windowFor picks. */
  activate(id: string, windowId?: string | null): void;
  activateIndex(windowId: string, index: number): void;
  cycle(windowId: string, delta: 1 | -1): void;
  navigate(id: string, input: string, options?: { userInitiated?: boolean }): void;
  // `live` patches the tab's live state in the same update (one pass over the store's subscribers).
  updateTab(id: string, patch: Partial<Tab>, live?: Partial<TabLive>): void;
  updateLive(id: string, patch: Partial<TabLive>): void;
  // The engine's report of the tab's page. Chrome records the visit in its history itself.
  navigated(id: string, page: { url: string; title: string }, live: Partial<TabLive>): void;
  // The page's icon. Chrome keeps it with the page (FaviconService).
  faviconChanged(id: string, favicon: string): void;
  duplicateTab(id: string): string | undefined;
  togglePin(id: string): void;
  moveTab(id: string, toIndex: number): void;
};

function pinnedInsertionIndex(s: BrowserState, list: string[]): number {
  let last = -1;
  list.forEach((id, i) => s.tabs[id]?.pinned && (last = i));
  return last + 1;
}

/** Whether the window can show the tab: a main window any tab of a space (it switches to it), a private window its
 *  own, a Little Bay its page. */
function canShow(s: BrowserState, w: BrowserWindow | undefined, tab: Tab): w is BrowserWindow {
  if (!w) return false;
  if (w.kind === "small" || s.windows[tab.windowId]?.kind === "small") return tab.windowId === w.id;
  if (w.incognito || isIncognitoSpace(tab.spaceId)) return tab.spaceId === w.spaceId;
  return true;
}

/** The window a tab opens in: the one asked for, else the frontmost one on its space (the focused one first, then the
 *  one with its page), else the focused one, else the one with its page, else any. */
export function windowFor(s: BrowserState, tab: Tab, requested?: string | null): BrowserWindow | undefined {
  const asked = requested ? s.windows[requested] : undefined;
  if (canShow(s, asked, tab)) return asked;
  const key = tabListKey(s, tab);
  const order = [...new Set([...s.ui.focusOrder, tab.windowId, ...s.windowOrder])].map((id) => s.windows[id]).filter((w) => canShow(s, w, tab));
  return order.find((w) => windowListKey(s, w!) === key && w!.id === s.ui.focusedWindowId) ?? order.find((w) => windowListKey(s, w!) === key) ?? order[0];
}

/** Shows the tab in a window (`windowId`, else windowFor's): its page moves there, as Arc's, from a window that showed
 *  it (which then says it's open in another window). */
export function activated(s: BrowserState, id: string, windowId?: string | null): Partial<BrowserState> {
  const tab = s.tabs[id];
  const w = tab && windowFor(s, tab, windowId);
  if (!tab || !w) return {};
  const lazy = !!tab.url && !tab.navigation && !tab.adoptId;
  const { unloaded: _, ...rest } = tab;
  // A favourite shared with the space on screen (the same profile) opens in it, and is that space's from now on: the
  // window stays where it is. Its page is the same engine profile's, so nothing reloads.
  const spaceId = tab.pinned && !w.incognito && tab.spaceId !== w.spaceId && sharesProfile(s, tab.spaceId, w.spaceId) ? w.spaceId : tab.spaceId;
  const nextTab: Tab = { ...rest, spaceId, windowId: w.id, lastActiveAt: Date.now(), ...(lazy ? wake(tab) : {}) };
  const window: BrowserWindow = {
    ...w,
    spaceId: w.incognito ? w.spaceId : spaceId,
    activeTabIds: { ...w.activeTabIds, [spaceId]: id },
  };
  const ui = s.windowUi[w.id];
  return {
    tabs: { ...s.tabs, [id]: nextTab },
    windows: { ...s.windows, [w.id]: window },
    ...(ui?.panel.open ? { windowUi: { ...s.windowUi, [w.id]: { ...ui, panel: { open: false, initialText: "" } } } } : {}),
  };
}

export const apply = (s: BrowserState, patch: Partial<BrowserState>): BrowserState => ({ ...s, ...patch });

export function removeTabs(s: BrowserState, ids: string[], record: boolean): BrowserState {
  const gone = new Set(ids.filter((id) => s.tabs[id]));
  if (gone.size === 0) return s;
  const now = Date.now();
  const closed: ClosedTab[] = [];
  const tabLists = { ...s.tabLists };
  for (const [key, list] of Object.entries(s.tabLists)) {
    if (!list.some((id) => gone.has(id))) continue;
    if (record) {
      list.forEach((id, index) => {
        const t = s.tabs[id];
        if (!t || !gone.has(id) || (!t.url && !t.pinned)) return;
        const group = Object.values(s.groups).find((g) => g.tabIds.includes(id));
        closed.push({
          kind: "tab",
          id: newId("ct"),
          tab: snapshotTab(t),
          tabId: id,
          windowId: t.windowId,
          index,
          group: group ? { id: group.id, name: group.name, icon: group.icon, color: group.color } : null,
          closedAt: now,
          ...(s.windows[key]?.kind === "small" ? { small: true } : {}),
        });
      });
    }
    const left = list.filter((id) => !gone.has(id));
    if (left.length) tabLists[key] = left;
    else delete tabLists[key];
  }

  // Each window shows another tab for a space whose shown one went. A private window and a Little Bay with nothing
  // left go.
  const windows = { ...s.windows };
  const removedWindows: string[] = [];
  for (const w of Object.values(s.windows)) {
    if ((w.incognito || w.kind === "small") && !tabLists[windowListKey(s, w)]) {
      removedWindows.push(w.id);
      delete windows[w.id];
      continue;
    }
    if (!Object.values(w.activeTabIds).some((id) => gone.has(id))) continue;
    windows[w.id] = { ...w, activeTabIds: successors(s, w, gone) };
  }
  const tabs = adoptOrphans(without(s.tabs, gone), s.tabs, gone);

  let next: BrowserState = {
    ...s,
    tabs,
    tabLists,
    windows,
    windowOrder: removedWindows.length ? s.windowOrder.filter((id) => !removedWindows.includes(id)) : s.windowOrder,
    windowUi: removedWindows.length ? without(s.windowUi, removedWindows) : s.windowUi,
    live: without(s.live, gone),
    find: without(s.find, gone),
    groups: leaveGroups(s.groups, gone),
    splits: removeFromSplits(s.splits, gone),
    selection: pruneSelection(s.selection, gone),
    closedTabs: closed.length ? [...s.closedTabs, ...closed].slice(-MAX_CLOSED_TABS) : s.closedTabs,
  };
  // A tab a window now shows that hasn't loaded loads; it's that window's.
  for (const w of Object.values(next.windows)) {
    if (!Object.values(s.windows[w.id]!.activeTabIds).some((id) => gone.has(id))) continue;
    const id = w.activeTabIds[w.spaceId];
    const t = id ? next.tabs[id] : undefined;
    if (t && t.url && !t.navigation && !t.adoptId) next = apply(next, activated(next, t.id, w.id));
  }
  return next;
}

/** The window's shown tab for each space, with each of `gone` replaced by the tab it shows next: one its
 *  opener opened, else the next one (awake first), else the one before. */
export function successors(s: BrowserState, w: BrowserWindow, gone: Set<string>): Record<string, string> {
  const activeTabIds = { ...w.activeTabIds };
  for (const [spaceId, activeId] of Object.entries(w.activeTabIds)) {
    if (!gone.has(activeId)) continue;
    const before = viewTabIds(s, w.id, spaceId);
    const left = before.filter((id) => !gone.has(id));
    const awake = left.filter((id) => !s.tabs[id]?.unloaded);
    const after = awake.length ? awake : left;
    const index = before.indexOf(activeId);
    const next = openerSuccessor(s, activeId, before, left) ?? after.find((id) => before.indexOf(id) > index) ?? after.at(-1);
    if (next) activeTabIds[spaceId] = next;
    else delete activeTabIds[spaceId];
  }
  return activeTabIds;
}

// A closed tab's tabs take its opener (TabStripModel::FixOpeners).
function adoptOrphans(tabs: Record<string, Tab>, before: Record<string, Tab>, gone: Set<string>): Record<string, Tab> {
  let next = tabs;
  for (const t of Object.values(tabs)) {
    let opener = t.openerId;
    while (opener && gone.has(opener)) opener = before[opener]?.openerId ?? null;
    if (opener === t.openerId) continue;
    if (next === tabs) next = { ...tabs };
    next[t.id] = { ...t, openerId: opener === t.id ? null : opener };
  }
  return next;
}

export function unloadPinnedTabs(s: BrowserState, ids: string[]): BrowserState {
  const closing = new Set(ids);
  const pinned = ids.filter((id) => inPinnedContainer(s, id));
  if (!pinned.length) return s;
  const gone = new Set(pinned);
  const now = Date.now();
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  const closed: ClosedTab[] = [];
  for (const id of pinned) {
    const t = s.tabs[id]!;
    const loaded = !!(t.navigation || t.adoptId);
    if (loaded && t.url) {
      closed.push({
        kind: "tab",
        id: newId("ct"),
        tab: snapshotTab(t),
        tabId: id,
        windowId: t.windowId,
        index: Math.max(listIds(s, tabListKey(s, t)).indexOf(id), 0),
        group: null,
        closedAt: now,
        pinnedTile: true,
      });
    }
    tabs[id] = { ...t, ...backToPin(s, t), navigation: null, adoptId: undefined, wakeAdoptId: undefined, unloaded: true };
    live[id] = IDLE_LIVE;
  }
  let next: BrowserState = {
    ...s,
    tabs,
    live,
    find: without(s.find, gone),
    splits: removeFromSplits(s.splits, gone),
    selection: pruneSelection(s.selection, gone),
    closedTabs: closed.length ? [...s.closedTabs, ...closed].slice(-MAX_CLOSED_TABS) : s.closedTabs,
  };
  for (const w of Object.values(s.windows)) {
    for (const [spaceId, activeId] of Object.entries(w.activeTabIds)) {
      if (!gone.has(activeId)) continue;
      const shown = spaceId === w.spaceId;
      let replacement = lastRegularTab(s, w, activeId, closing) ?? lastLivePinnedTab(s, w, activeId, closing);
      if (!replacement) [next, replacement] = withNewTab(next, w.id, { spaceId, background: !shown });
      if (shown) next = apply(next, activated(next, replacement, w.id));
      else {
        const win = next.windows[w.id]!;
        next = { ...next, windows: { ...next.windows, [w.id]: { ...win, activeTabIds: { ...win.activeTabIds, [spaceId]: replacement } } } };
      }
    }
  }
  return next;
}

function backToPin(s: BrowserState, t: Tab): Partial<Tab> {
  const home = t.pinnedUrl;
  if (!home || !t.url || samePage(t.url, home)) return {};
  const entry = s.history[t.spaceId]?.find((h) => samePage(h.url, home));
  return { ...onUrlChange(s, t, home), url: home, ...(entry ? { title: entry.title, favicon: entry.favicon ?? t.favicon } : {}) };
}

function lastRegularTab(s: BrowserState, w: BrowserWindow, id: string, closing: Set<string>): string | undefined {
  const spaceId = s.tabs[id]!.spaceId;
  const candidates = viewTabIds(s, w.id, spaceId).filter((t) => !closing.has(t) && !inPinnedContainer(s, t));
  const panes = splitOf(s, id)?.tabIds.filter((t) => candidates.includes(t)) ?? [];
  const pool = panes.length ? panes : candidates;
  return pool.reduce<string | undefined>((best, t) => (!best || s.tabs[t]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? t : best), undefined);
}

function lastLivePinnedTab(s: BrowserState, w: BrowserWindow, id: string, closing: Set<string>): string | undefined {
  const spaceId = s.tabs[id]!.spaceId;
  const live = viewTabIds(s, w.id, spaceId).filter((t) => {
    const tab = s.tabs[t]!;
    return !closing.has(t) && inPinnedContainer(s, t) && !!(tab.navigation || tab.adoptId);
  });
  return live.reduce<string | undefined>((best, t) => (!best || s.tabs[t]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? t : best), undefined);
}

export function withNewTab(s: BrowserState, windowId: string, o: NewTabOptions = {}): [BrowserState, string] {
  const w = s.windows[windowId];
  if (!w) return [s, ""];
  const spaceId = w.incognito ? w.spaceId : o.spaceId && s.spaces[o.spaceId] ? o.spaceId : w.spaceId;
  // A link opened in front starts a new task: Chrome forgets the list's other openers.
  if (o.openerId && !o.background) s = forgetOpeners(s, w.kind === "small" ? w.id : spaceListKey(s, spaceId));
  const url = o.url ? resolveInput(o.url, searchUrlPrefix(s.settings)) : "";
  // Its page is this window's until another shows it.
  const tab = makeTab(windowId, spaceId, url, { ...o.snapshot, pinned: o.pinned ?? o.snapshot?.pinned ?? false });
  if (tab.navigation && !o.snapshot) tab.navigation = navigationTo(url, true);
  tab.openerId = o.openerId ?? null;
  tab.pinnedUrl = pinnedPage(tab) ? tab.pinnedUrl || url || null : null;
  if (o.adoptId) {
    // The adopted browser is already loading `url`; reloading drops POST data and opener state.
    tab.adoptId = o.adoptId;
    tab.navigation = null;
  } else if (o.wakeAdoptId) {
    tab.wakeAdoptId = o.wakeAdoptId;
    tab.navigation = null;
  }
  const tabs = { ...s.tabs, [tab.id]: tab };
  const key = w.kind === "small" ? w.id : spaceListKey(s, spaceId);
  const list = { key, tabIds: [...listIds(s, key)] };
  const at = o.index ?? (tab.pinned ? pinnedInsertionIndex(s, list.tabIds) : insertionIndex(s, list, tab, !!o.background));
  list.tabIds.splice(Math.min(at, list.tabIds.length), 0, tab.id);
  const window: BrowserWindow = {
    ...w,
    activeTabIds: w.activeTabIds[spaceId] ? w.activeTabIds : { ...w.activeTabIds, [spaceId]: tab.id },
  };
  let next: BrowserState = withList(
    { ...s, tabs, live: { ...s.live, [tab.id]: IDLE_LIVE }, windows: { ...s.windows, [windowId]: window } },
    { key, tabIds: pinnedFirst(list.tabIds, tabs) },
  );
  if (!o.background) next = apply(next, activated(next, tab.id, windowId));
  return [next, tab.id];
}

export const createTabsSlice: StateCreator<BrowserState, [], [], TabsSlice> = (set, get) => ({
  tabs: {},
  tabLists: {},
  live: {},
  closedTabs: [],

  newTab(windowId, options) {
    const small = get().windows[windowId];
    if (small?.kind === "small" && listIds(get(), small.id).length) {
      // Little Bay keeps its one page; new tabs go to a main window of that profile.
      const spaceId = options?.spaceId ?? small.spaceId;
      const main = mainWindowFor(get(), spaceId);
      if (!main) {
        const created = get().createWindow({ spaceId, url: options?.url, adoptId: options?.adoptId ?? options?.wakeAdoptId, background: options?.background });
        return activeTabId(get(), created) ?? "";
      }
      // The Little Bay page stays the opener, so the tabs it sends keep their order.
      return get().newTab(main, { ...options, spaceId, index: undefined });
    }
    if (options?.url && !options.adoptId && openOutsideTab(resolveInput(options.url, searchUrlPrefix(get().settings)), windowId)) return "";
    let [next, id] = withNewTab(get(), windowId, options);
    if (id && options?.openerId) next = groupWithOpener(next, id, options.openerId, !!options.background);
    set(next);
    return id;
  },

  closeTab(id) {
    const s = get();
    const tab = s.tabs[id];
    if (!tab) return;
    if (inPinnedContainer(s, id)) return set(unloadPinnedTabs(s, [id]));
    // Its window's last open tab: the tab closes, then the window (its space keeps its other tabs).
    const last = closesWindow(s, id) ? tab.windowId : undefined;
    set(removeTabs(s, [id], true));
    if (last && get().windows[last]) get().closeWindow(last);
  },

  closeTabs(ids) {
    let s = unloadPinnedTabs(get(), ids);
    const closing = ids.filter((id) => !inPinnedContainer(s, id));
    for (const w of Object.values(s.windows)) {
      const view = viewTabIds(s, w.id);
      if (view.some((id) => closing.includes(id)) && view.every((id) => closing.includes(id) || s.tabs[id]!.unloaded)) {
        s = withNewTab(s, w.id)[0];
      }
    }
    set(removeTabs(s, closing, true));
  },

  removeTab(id) {
    set(removeTabs(get(), [id], true));
  },

  activate(id, windowId) {
    const s = get();
    const tab = s.tabs[id];
    const w = tab && windowFor(s, tab, windowId);
    if (!tab || !w) return;
    const shown = activeTabId(s, w.id);
    let next = apply(s, activated(s, id, w.id));
    if (shown && shown !== id && !switchKeepsOpeners(s, shown, id)) next = forgetOpeners(next, tabListKey(next, next.tabs[id]!));
    set(next);
  },

  activateIndex(windowId, index) {
    const view = viewTabIds(get(), windowId);
    const id = index < 0 ? view.at(-1) : view[index];
    if (id) get().activate(id, windowId);
  },

  cycle(windowId, delta) {
    const s = get();
    const view = viewTabIds(s, windowId);
    const i = view.indexOf(s.windows[windowId]?.activeTabIds[s.windows[windowId]!.spaceId] ?? "");
    if (view.length) get().activate(view[(i + delta + view.length) % view.length]!, windowId);
  },

  navigate(id, input, { userInitiated = true } = {}) {
    const s = get();
    const url = resolveInput(input, searchUrlPrefix(s.settings));
    const tab = s.tabs[id];
    if (!url || !tab) return;
    const panel = s.windowUi[tab.windowId]?.panel;
    if (openOutsideTab(url, tab.windowId)) {
      const current = get().windowUi[tab.windowId]?.panel;
      // An app URL may open a new palette session instead of navigating the page.
      if (current?.open && current.sessionId === panel?.sessionId) get().closePanel(tab.windowId);
      return;
    }
    // A new address supersedes a link the tab kept to load when shown (the engine drops it: lib/chromeTabs.ts).
    const { unloaded: _, wakeAdoptId: _kept, ...rest } = tab;
    // Typing an address starts a new task (a New Tab page gets one lookup first, as in Chrome).
    const base = userInitiated && tab.url ? forgetOpeners(s, tabListKey(s, tab)) : s;
    // A typed address opens in its site's engine (store/engines.ts); moving engines drops the page the tab adopted.
    const engine = userInitiated ? typedNavigationEngine(s, tab, url) : undefined;
    const page = engine ? { engine, ...(engine !== tabEngine(s, id) ? { adoptId: undefined } : {}) } : {};
    set(
      apply(base, {
        tabs: {
          ...base.tabs,
          [id]: { ...rest, openerId: base.tabs[id]!.openerId, navigation: navigationTo(url, userInitiated), url: tab.url || url, ...page },
        },
      }),
    );
    const ui = get().windowUi[tab.windowId];
    if (ui?.panel.open) get().closePanel(tab.windowId);
  },

  updateTab(id, patch, livePatch) {
    const s = get();
    const tab = s.tabs[id];
    if (!tab) return;
    const url = patch.url;
    // Loading something else supersedes the link the tab kept to load when shown.
    const supersedes = !!tab.wakeAdoptId && !("wakeAdoptId" in patch) && (!!patch.navigation || !!patch.adoptId || (url !== undefined && url !== tab.url));
    const change = supersedes ? { ...patch, wakeAdoptId: undefined } : patch;
    const next = merge(tab, url !== undefined && url !== tab.url ? { ...onUrlChange(s, tab, url), ...change } : change);
    const live = livePatch ? s.live[id] : undefined;
    const nextLive = live && livePatch ? merge(live, livePatch) : live;
    if (next === tab && nextLive === live) return;
    set((s) => ({
      ...(next !== tab ? { tabs: { ...s.tabs, [id]: next } } : {}),
      ...(nextLive !== live ? { live: { ...s.live, [id]: nextLive! } } : {}),
    }));
  },

  updateLive(id, patch) {
    const live = get().live[id];
    if (!live) return;
    const next = merge(live, patch);
    if (next !== live) set((s) => ({ live: { ...s.live, [id]: next } }));
  },

  navigated(id, page, live) {
    get().updateTab(id, page, live);
  },

  faviconChanged(id, favicon) {
    get().updateTab(id, { favicon });
  },

  duplicateTab(id) {
    const s = get();
    const source = s.tabs[id];
    if (!source) return undefined;
    const w = windowFor(s, source, source.windowId);
    if (!w) return undefined;
    const [next, copy] = withNewTab(s, w.id, {
      url: source.url || undefined,
      spaceId: source.spaceId,
      snapshot: { ...snapshotTab(source), pinned: false, pinnedRow: undefined },
      index: listIds(s, tabListKey(s, source)).indexOf(id) + 1,
      adoptId: source.url ? `clone:${id}` : undefined,
    });
    set(next);
    return copy;
  },

  togglePin(id) {
    const tab = get().tabs[id];
    if (tab) get().pinTabs([id], !tab.pinned);
  },

  moveTab(id, toIndex) {
    set((s) => {
      const tab = s.tabs[id];
      const list = listOfTab(s, id);
      if (!tab || !list) return {};
      const inSection = (t: string) => s.tabs[t]?.spaceId === tab.spaceId && !!s.tabs[t]?.pinned === tab.pinned;
      const section = list.tabIds.filter(inSection);
      const moved = section.filter((t) => t !== id);
      moved.splice(Math.min(Math.max(toIndex, 0), moved.length), 0, id);
      let k = 0;
      // The pinned rows share a section with the list here (both aren't Essentials): neither crosses into the other.
      const tabIds = orderSections(
        list.tabIds.map((t) => (inSection(t) ? moved[k++]! : t)),
        s.tabs,
        s.groups,
        s.pinnedFolders,
      );
      const next = { key: list.key, tabIds };
      return { tabLists: withList(s, next).tabLists, groups: syncGroupOrder(s.groups, next) };
    });
  },
});
