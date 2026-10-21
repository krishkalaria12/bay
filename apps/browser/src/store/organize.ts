import { folderInsertionBeforeId, folderTabIds, withFolderPlacementUndo } from "./folders";
import type { StateCreator } from "zustand";
import type { BrowserProjection, DeepReadonly } from "../runtime/projection";
import type { BrowserState } from "./browser";
import { autoGroupName } from "./groupNames";
import { leaveGroups, orderSections, placeBlock, syncGroupOrder } from "./groups";
import {
  activeTabId,
  inPinnedContainer,
  isIncognitoSpace,
  listOfTab,
  newId,
  pinnedPage,
  sharesProfile,
  shownElsewhere,
  snapshotTab,
  viewTabIds,
  windowTabIds,
  withList,
  without,
  type TabList,
} from "./model";
import { activated, apply, removeTabs, withNewTab } from "./tabs";
import type { ClosedGroup, ClosedTab, Tab, TabGroup } from "./types";
import { CLEAN_UP_AFTER_MS, DELETED_GROUP_MS, MAX_CLEANED, MAX_CLOSED_GROUPS, RECENT_TABS } from "./constants";

export type TabPlacement = {
  // An Essential (a pinned tile).
  pinned: boolean;
  // A pinned row (in `folderId`'s folder, else loose); false unpins one; left out, a pinned row stays one.
  row?: boolean;
  folderId?: string | null;
  beforeId?: string | null;
  groupId?: string | null;
};

export type GroupPlacement = { pinned: boolean; beforeId?: string | null };

export type OrganizeSlice = {
  selection: Record<string, string[]>;
  cleanedTabs: ClosedTab[];
  // Private windows' cleanup records and site mutes, by window id: memory only, gone with the window.
  privateCleanedTabs: Record<string, ClosedTab[]>;
  privateSiteMutes: Record<string, Record<string, boolean>>;
  closedGroups: ClosedGroup[];
  deletedGroups: ClosedGroup[];

  setSelection(windowId: string, ids: string[]): void;
  placeTabs(ids: string[], placement: TabPlacement): void;
  pinTabs(ids: string[], pinned: boolean): void;
  pinRows(ids: string[], pinned: boolean): void;
  returnToPinnedUrl(tabId: string): void;
  setPinnedUrl(tabId: string, url?: string): void;
  setMuted(ids: string[], muted: boolean): void;
  setSiteMuted(tabId: string, muted: boolean): void;

  groupTabs(ids: string[], options?: { pinned?: boolean; name?: string }): string;
  moveGroup(groupId: string, placement: GroupPlacement): void;
  duplicateGroup(groupId: string): string;
  newTabInGroup(groupId: string, url?: string): string;
  moveGroupToBookmarksBar(groupId: string): void;

  /** Cleans up the tabs of the space the window shows, or of `spaceId`. */
  cleanUpTabs(windowId: string, options?: { inactiveForMs?: number; spaceId?: string }): number;
  /** The automatic clean up (Arc's archive): every window's spaces, each after its own time. */
  cleanUpInactiveTabs(): number;
  /** Puts cleaned up tabs back: one entry (returning its tab), or every one. */
  restoreCleaned(entryId?: string, windowId?: string): string | undefined;
  closeAbandonedNewTabs(): void;
};

export const keptDeletedGroups = <G extends Pick<ClosedGroup, "closedAt">>(list: readonly G[], now = Date.now()) =>
  list.filter((c) => now - c.closedAt < DELETED_GROUP_MS);

export const groupOf = <S extends Pick<BrowserState, "groups"> | Pick<BrowserProjection, "groups">>(
  s: S,
  tabId: string | undefined,
): S["groups"][string] | undefined => (tabId ? (Object.values(s.groups) as S["groups"][string][]).find((g) => g.tabIds.includes(tabId)) : undefined);

export function selectedTabIds(s: BrowserState | BrowserProjection, windowId: string): string[] {
  const view = viewTabIds(s, windowId);
  const selected = (s.selection[windowId] ?? []).filter((id) => view.includes(id));
  if (selected.length) return view.filter((id) => selected.includes(id));
  const active = activeTabId(s, windowId);
  return active ? [active] : [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function samePage(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}

export const awayFromPin = (t: Pick<Tab, "pinned" | "pinnedRow" | "url" | "pinnedUrl">) =>
  pinnedPage(t) && !!t.pinnedUrl && !!t.url && !samePage(t.url, t.pinnedUrl);

// A name the user gave wins; otherwise one from the tabs' titles (store/groupNames.ts).
type ReadTab = DeepReadonly<Tab>;
const autoLabels = new WeakMap<object, { tabs: object; members: (ReadTab | undefined)[]; label: string }>();

// Memoized per group on its member tabs: headers ask on every store update, and naming reads every title.
export function groupLabel(s: Pick<BrowserProjection, "tabs">, g: DeepReadonly<TabGroup>): string {
  if (g.name) return g.name;
  const cached = autoLabels.get(g);
  if (cached && (cached.tabs === s.tabs || g.tabIds.every((id, i) => s.tabs[id] === cached.members[i]))) {
    cached.tabs = s.tabs;
    return cached.label;
  }
  const members = g.tabIds.map((id) => s.tabs[id]);
  const label = autoGroupName(members.filter((t): t is ReadTab => !!t?.url)) || "New Group";
  autoLabels.set(g, { tabs: s.tabs, members, label });
  return label;
}

export function isSiteMuted(s: Pick<BrowserState, "settings" | "privateSiteMutes">, tab: Pick<Tab, "windowId" | "spaceId">, host: string): boolean {
  const own = isIncognitoSpace(tab.spaceId) ? s.privateSiteMutes[tab.windowId]?.[host] : undefined;
  return own ?? (s.settings.mutedSites ?? []).includes(host);
}

export const cleanedTabsFor = <
  S extends Pick<BrowserState, "windows" | "cleanedTabs" | "privateCleanedTabs"> | Pick<BrowserProjection, "windows" | "cleanedTabs" | "privateCleanedTabs">,
>(
  s: S,
  windowId: string,
): S["cleanedTabs"] => (s.windows[windowId]?.incognito ? (s.privateCleanedTabs[windowId] ?? NO_CLEANED) : s.cleanedTabs);
const NO_CLEANED: ClosedTab[] = [];

export function onUrlChange(s: BrowserState, tab: Tab, url: string): Partial<Tab> {
  const patch: Partial<Tab> = {};
  const before = hostOf(tab.url);
  const after = hostOf(url);
  if (before !== after) {
    if (isSiteMuted(s, tab, after)) patch.muted = true;
    else if (isSiteMuted(s, tab, before)) patch.muted = false;
  }
  if (pinnedPage(tab) && !tab.pinnedUrl && url) patch.pinnedUrl = url;
  return patch;
}

export function pruneSelection(selection: Record<string, string[]>, gone: Set<string>): Record<string, string[]> {
  if (!Object.values(selection).some((ids) => ids.some((id) => gone.has(id)))) return selection;
  return Object.fromEntries(Object.entries(selection).map(([w, ids]) => [w, ids.filter((id) => !gone.has(id))]));
}

// A tab opened from a link joins its opener's group, as in Chrome; opened behind from an ungrouped tab it
// starts one with it when the setting is on (Dia's "⌘-clicking links creates tab groups"). A pinned tab (or a
// tab of a pinned group) stays in its section: its links opened behind gather in a group of their own, below
// the pinned tabs, as in Dia.
export function groupWithOpener(s: BrowserState, tabId: string, openerId: string, background: boolean): BrowserState {
  const tab = s.tabs[tabId];
  const opener = s.tabs[openerId];
  if (!tab || !opener) return s;
  const w = listOfTab(s, tabId);
  if (!w || opener.spaceId !== tab.spaceId || !w.tabIds.includes(openerId)) return s;
  if (inPinnedContainer(s, openerId)) {
    const gathered = pinnedChildGroup(s, openerId, tab.spaceId);
    if (gathered) return joinGroup(s, w, gathered, tabId);
    if (!background || !s.settings.cmdClickCreatesTabGroup) return s;
    return withGroup(s, [tabId], { autoUngroup: true, pinnedOpenerId: openerId })[0];
  }
  const existing = groupOf(s, openerId);
  if (!existing && !(background && s.settings.cmdClickCreatesTabGroup)) return s;
  if (existing) return joinGroup(s, w, existing, tabId);
  // A split opener brings its other panes: a split is one row, inside or outside the group.
  const panes = Object.values(s.splits).find((v) => v.tabIds.includes(openerId))?.tabIds ?? [openerId];
  return withGroup(s, [...panes, tabId], { autoUngroup: true })[0];
}

export const pinnedChildGroup = (s: Pick<BrowserState, "groups">, openerId: string, spaceId: string): TabGroup | undefined =>
  Object.values(s.groups).find((g) => g.pinnedOpenerId === openerId && g.spaceId === spaceId && g.tabIds.length);

// A link joining its opener's group opens the group, so the tab is seen (Dia 1.47.1: no longer hidden in a collapsed one).
function joinGroup(s: BrowserState, w: TabList, group: TabGroup, tabId: string): BrowserState {
  const members = [...group.tabIds, tabId];
  const list = {
    key: w.key,
    tabIds: placeBlock(
      w.tabIds,
      w.tabIds.filter((id) => members.includes(id)),
    ),
  };
  const groups = { ...s.groups, [group.id]: { ...group, collapsed: false, tabIds: list.tabIds.filter((id) => members.includes(id)) } };
  return { ...withList(s, list), groups };
}

export function withGroup(
  s: BrowserState,
  ids: string[],
  o: { name?: string; pinned?: boolean; autoUngroup?: boolean; pinnedOpenerId?: string } = {},
): [BrowserState, string] {
  const tabs = ids.map((id) => s.tabs[id]).filter((t): t is Tab => !!t && !pinnedPage(t));
  const first = tabs[0];
  const w = first && listOfTab(s, first.id);
  if (!first || !w || tabs.some((t) => t.spaceId !== first.spaceId || !w.tabIds.includes(t.id))) return [s, ""];
  const members = new Set(tabs.map((t) => t.id));
  let tabIds = placeBlock(
    w.tabIds,
    w.tabIds.filter((id) => members.has(id)),
  );
  const group: TabGroup = {
    id: newId("g"),
    spaceId: first.spaceId,
    name: o.name ?? "",
    icon: null,
    color: null,
    collapsed: false,
    pinned: !!o.pinned,
    tabIds: tabIds.filter((id) => members.has(id)),
    createdAt: Date.now(),
    ...(o.autoUngroup ? { autoUngroup: true } : {}),
    ...(o.pinnedOpenerId ? { pinnedOpenerId: o.pinnedOpenerId } : {}),
  };
  const groups = { ...leaveGroups(s.groups, members), [group.id]: group };
  tabIds = orderSections(tabIds, s.tabs, groups, s.pinnedFolders);
  const list = { key: w.key, tabIds };
  return [{ ...withList(s, list), groups: syncGroupOrder(groups, list) }, group.id];
}

function closedEntries(s: BrowserState, ids: string[]): ClosedTab[] {
  const now = Date.now();
  return ids
    .map((id) => s.tabs[id])
    .filter((t): t is Tab => !!t && !!t.url)
    .map((t) => {
      const group = groupOf(s, t.id);
      return {
        kind: "tab" as const,
        id: newId("ct"),
        tab: snapshotTab(t),
        windowId: t.windowId,
        index: Math.max(listOfTab(s, t.id)?.tabIds.indexOf(t.id) ?? 0, 0),
        group: group ? { id: group.id, name: group.name, icon: group.icon, color: group.color } : null,
        closedAt: now,
      };
    });
}

function closeQuietly(s: BrowserState, ids: string[]): BrowserState {
  for (const w of Object.values(s.windows)) {
    const view = viewTabIds(s, w.id);
    if (view.length && view.every((id) => ids.includes(id))) s = withNewTab(s, w.id)[0];
  }
  return removeTabs(s, ids, false);
}

// Closing a group that holds the page on screen shows the tab just above the group, as in Dia (not the opener
// of the page, nor the tab after it); at the top of the list, the one below.
// Each window that showed one of its tabs.
function showAboveGroup(before: BrowserState, s: BrowserState, g: TabGroup): BrowserState {
  for (const w of Object.values(s.windows)) {
    const was = before.windows[w.id]?.activeTabIds[g.spaceId];
    if (!was || !g.tabIds.includes(was)) continue;
    const order = viewTabIds(before, w.id, g.spaceId).filter((id) => !inPinnedContainer(before, id));
    const at = order.indexOf(g.tabIds[0]!);
    const stays = (id: string) => !!s.tabs[id] && !g.tabIds.includes(id) && !s.tabs[id]!.unloaded;
    const pick = order.slice(0, at).reverse().find(stays) ?? order.slice(at).find(stays);
    if (!pick) continue;
    const window = s.windows[w.id]!;
    if (window.spaceId === g.spaceId) s = apply(s, activated(s, pick, w.id));
    else s = { ...s, windows: { ...s.windows, [w.id]: { ...window, activeTabIds: { ...window.activeTabIds, [g.spaceId]: pick } } } };
  }
  return s;
}

/** The window a group is in: the frontmost one on its space, else its first tab's page's. */
export function groupWindow(s: BrowserState, g: TabGroup): string | undefined {
  const first = g.tabIds[0] ? s.tabs[g.tabIds[0]] : undefined;
  return (
    [...s.ui.focusOrder, ...s.windowOrder].find((id) => s.windows[id]?.spaceId === g.spaceId) ??
    (first && s.windows[first.windowId] ? first.windowId : undefined)
  );
}

export function closingGroup(s: BrowserState, groupId: string, deleted = false): BrowserState {
  const g = s.groups[groupId];
  const list = g?.tabIds[0] ? listOfTab(s, g.tabIds[0]) : undefined;
  if (!g || !list) return s;
  const entry: ClosedGroup = {
    kind: "group",
    id: newId("cg"),
    group: { id: g.id, name: groupLabel(s, g), icon: g.icon, color: g.color, pinned: g.pinned },
    tabs: g.tabIds.map((id) => snapshotTab(s.tabs[id]!)),
    windowId: groupWindow(s, g) ?? "",
    index: list.tabIds.indexOf(g.tabIds[0]!),
    closedAt: Date.now(),
  };
  const recordable = !isIncognitoSpace(g.spaceId) && entry.tabs.some((t) => t.url);
  const next = showAboveGroup(s, closeQuietly(s, g.tabIds), g);
  if (!recordable) return next;
  if (deleted) return { ...next, deletedGroups: [...keptDeletedGroups(next.deletedGroups), entry] };
  return { ...next, closedGroups: [...next.closedGroups, entry].slice(-MAX_CLOSED_GROUPS) };
}

function restoreSnapshots(s: BrowserState, windowId: string, entries: { tab: ClosedTab["tab"]; index?: number }[]): [BrowserState, string[]] {
  const ids: string[] = [];
  const w = s.windows[windowId]!;
  for (const e of entries) {
    const spaceId = s.spaces[e.tab.spaceId] || w.incognito ? e.tab.spaceId : w.spaceId;
    const [next, id] = withNewTab(s, windowId, {
      url: e.tab.url || undefined,
      spaceId,
      snapshot: e.tab,
      index: e.index,
      background: true,
    });
    s = next;
    ids.push(id);
  }
  return [s, ids];
}

function restoreTarget(s: BrowserState, original: string, requested?: string | null): string | undefined {
  const ok = (id: string | null | undefined) => !!id && !!s.windows[id] && !s.windows[id]!.incognito;
  if (ok(original)) return original;
  if (ok(requested)) return requested!;
  return s.ui.focusOrder.find((id) => ok(id)) ?? s.windowOrder.find((id) => ok(id));
}

export function restoringGroup(s: BrowserState, entry: ClosedGroup, requested?: string | null): BrowserState {
  const windowId = restoreTarget(s, entry.windowId, requested);
  if (!windowId) return s;
  let next: BrowserState = {
    ...s,
    closedGroups: s.closedGroups.filter((c) => c.id !== entry.id),
    deletedGroups: s.deletedGroups.filter((c) => c.id !== entry.id),
  };
  const index = windowId === entry.windowId ? entry.index : undefined;
  const [restored, ids] = restoreSnapshots(
    next,
    windowId,
    entry.tabs.map((tab, i) => ({ tab: { ...tab, pinned: false }, index: index === undefined ? undefined : index + i })),
  );
  next = restored;
  const [grouped, groupId] = withGroup(next, ids, { name: entry.group.name, pinned: entry.group.pinned });
  next = grouped;
  if (groupId && next.groups[groupId]) {
    next = { ...next, groups: { ...next.groups, [groupId]: { ...next.groups[groupId]!, icon: entry.group.icon, color: entry.group.color } } };
  }
  return ids[0] ? apply(next, activated(next, ids[0])) : next;
}

/** How long a space's tabs stay unused before they're cleaned up automatically, in hours: never if null. */
export function cleanUpHours(s: Pick<BrowserState, "spaces" | "settings">, spaceId: string): number | null {
  const own = s.spaces[spaceId]?.cleanUpAfterHours;
  return own === undefined ? s.settings.cleanUpInactiveTabsAfterHours : own;
}

export function cleanUpCandidates(s: BrowserProjection, windowId: string, inactiveForMs = CLEAN_UP_AFTER_MS, now = Date.now(), spaceId?: string): string[] {
  const view = viewTabIds(s, windowId, spaceId);
  // The tab any window shows for the space stays.
  const space = spaceId ?? s.windows[windowId]?.spaceId ?? "";
  const shown = new Set(Object.keys(s.windows).map((w) => activeTabId(s, w, space)));
  const active = activeTabId(s, windowId, spaceId);
  const grouped = new Set(Object.values(s.groups).flatMap((g) => g.tabIds));
  const inSplit = new Set(Object.values(s.splits).flatMap((v) => v.tabIds));
  const keep = (t: Tab) => shown.has(t.id) || pinnedPage(t) || t.kept || s.live[t.id]?.playingAudio;
  const out = new Set<string>();
  const byPage = new Map<string, Tab[]>();
  for (const id of view) {
    const t = s.tabs[id]!;
    if (!t.url) continue;
    const key = t.url.replace(/#.*$/, "");
    byPage.set(key, [...(byPage.get(key) ?? []), t]);
  }
  for (const same of byPage.values()) {
    if (same.length < 2) continue;
    const keeper = same.find(pinnedPage) ?? same.find((t) => t.id === active) ?? [...same].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]!;
    for (const t of same) if (t !== keeper && !keep(t) && !inSplit.has(t.id)) out.add(t.id);
  }
  for (const id of view) {
    const t = s.tabs[id]!;
    if (keep(t) || grouped.has(id) || inSplit.has(id)) continue;
    if (now - t.lastActiveAt >= inactiveForMs) out.add(id);
  }
  return view.filter((id) => out.has(id));
}

export function abandonedNewTabs(s: BrowserState, windowId: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const selected = new Set(Object.values(w.activeTabIds));
  const shown = w.activeTabIds[w.spaceId];
  const mine = windowTabIds(s, windowId);
  const out = mine.filter((id) => {
    const t = s.tabs[id]!;
    return !t.url && !t.navigation && !t.adoptId && !t.pinned && id !== shown && !selected.has(id);
  });
  return out.length >= mine.length ? out.slice(0, mine.length - 1) : out;
}

/** As Arc's ⌃Tab: the most recent tabs of every space the window can show (not one another window shows now). */
export function recentTabIds(s: BrowserProjection, windowId: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const spaces = w.incognito || w.kind === "small" ? [w.spaceId] : s.spaceOrder;
  const tabs = spaces.flatMap((space) => viewTabIds(s, windowId, space)).filter((id) => !shownElsewhere(s, id, windowId));
  return tabs.sort((a, b) => s.tabs[b]!.lastActiveAt - s.tabs[a]!.lastActiveAt).slice(0, RECENT_TABS);
}

export function placing(s: BrowserState, ids: string[], p: TabPlacement): BrowserState {
  const first = s.tabs[ids[0] ?? ""];
  const w = first && listOfTab(s, first.id);
  if (!first || !w) return s;
  const order = new Map(w.tabIds.map((id, i) => [id, i]));
  // Favourites are shared by the spaces with one profile: a selection of them can come from several.
  const moves = (t: Tab | undefined) =>
    !!t && order.has(t.id) && (t.spaceId === first.spaceId || (p.pinned && t.pinned && sharesProfile(s, t.spaceId, first.spaceId)));
  const moving = [...new Set(ids)].filter((id) => moves(s.tabs[id])).sort((a, b) => order.get(a)! - order.get(b)!);
  if (!moving.length) return s;
  const target = !p.pinned && !p.row && p.groupId ? s.groups[p.groupId] : undefined;
  if (target && target.spaceId !== first.spaceId) return s;
  const folder = !p.pinned && p.row && p.folderId ? s.pinnedFolders[p.folderId] : undefined;
  if (p.folderId && p.row && (!folder || folder.spaceId !== first.spaceId)) return s;
  const movingSet = new Set(moving);

  const tabs = { ...s.tabs };
  for (const id of moving) {
    const t = tabs[id]!;
    // A tab into a group leaves the Pinned section; one placed with no word on it keeps its row.
    const row = !p.pinned && !target && (p.row ?? !!t.pinnedRow);
    const folderId = row ? (p.row ? (folder?.id ?? undefined) : t.folderId) : undefined;
    if (t.pinned === p.pinned && !!t.pinnedRow === row && t.folderId === folderId) continue;
    const pinnedUrl = p.pinned || row ? (pinnedPage(t) ? t.pinnedUrl : t.url || null) : null;
    const { pinnedRow: _, folderId: _f, ...rest } = t;
    tabs[id] = { ...rest, pinned: p.pinned, pinnedUrl, ...(row ? { pinnedRow: true } : {}), ...(folderId ? { folderId } : {}) };
  }
  const rest = w.tabIds.filter((id) => !movingSet.has(id));
  let at: number;
  if (p.beforeId && rest.includes(p.beforeId)) at = rest.indexOf(p.beforeId);
  else if (target) {
    const kept = target.tabIds.filter((id) => !movingSet.has(id));
    at = kept.length ? rest.indexOf(kept.at(-1)!) + 1 : Math.min(order.get(target.tabIds[0]!)!, rest.length);
  } else if (folder && folderTabIds(s, folder.id).some((id) => !movingSet.has(id))) {
    const subtree = new Set(folderTabIds(s, folder.id));
    at = rest.reduce((last, id, i) => (subtree.has(id) ? i + 1 : last), 0);
  } else if (folder) {
    const anchor = folderInsertionBeforeId(s, folder.id, moving);
    at = anchor && rest.includes(anchor) ? rest.indexOf(anchor) : rest.reduce((last, id, i) => (pinnedPage(tabs[id] ?? { pinned: false }) ? i + 1 : last), 0);
  } else if (p.pinned) at = rest.reduce((last, id, i) => (tabs[id]?.pinned ? i + 1 : last), 0);
  else if (p.row) at = rest.reduce((last, id, i) => (pinnedPage(tabs[id] ?? { pinned: false }) ? i + 1 : last), 0);
  else at = rest.length;
  rest.splice(at, 0, ...moving);

  let groups = leaveGroups(s.groups, movingSet);
  if (target) {
    const members = new Set([...target.tabIds, ...moving]);
    groups = { ...groups, [target.id]: { ...target, tabIds: rest.filter((id) => members.has(id)) } };
  }
  let tabIds = rest;
  for (const g of Object.values(groups))
    if (g.tabIds.some((id) => order.has(id)))
      tabIds = placeBlock(
        tabIds,
        tabIds.filter((id) => g.tabIds.includes(id)),
      );
  tabIds = orderSections(tabIds, tabs, groups, s.pinnedFolders);
  const list = { key: w.key, tabIds };
  return { ...withList({ ...s, tabs }, list), groups: syncGroupOrder(groups, list) };
}

export function forgetClosedPrivateWindows(s: BrowserState): Partial<BrowserState> | null {
  const gone = (map: Record<string, unknown>) => Object.keys(map).filter((id) => !s.windows[id]);
  const cleaned = gone(s.privateCleanedTabs);
  const mutes = gone(s.privateSiteMutes);
  if (!cleaned.length && !mutes.length) return null;
  return { privateCleanedTabs: without(s.privateCleanedTabs, cleaned), privateSiteMutes: without(s.privateSiteMutes, mutes) };
}

export const createOrganizeSlice: StateCreator<BrowserState, [], [], OrganizeSlice> = (set, get) => ({
  selection: {},
  cleanedTabs: [],
  privateCleanedTabs: {},
  privateSiteMutes: {},
  closedGroups: [],
  deletedGroups: [],

  setSelection(windowId, ids) {
    set((s) => {
      const view = new Set(viewTabIds(s, windowId));
      const next = [...new Set(ids)].filter((id) => view.has(id));
      const prev = s.selection[windowId] ?? [];
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return {};
      return { selection: { ...s.selection, [windowId]: next } };
    });
  },

  placeTabs(ids, placement) {
    set((s) => withFolderPlacementUndo(s, placing(s, ids, placement), ids));
  },

  pinTabs(ids, pinned) {
    const s = get();
    const w = listOfTab(s, ids[0] ?? "");
    if (!w) return;
    const beforeId = pinned ? null : w.tabIds.find((id) => !inPinnedContainer(s, id) && !ids.includes(id));
    set(placing(s, ids, { pinned, beforeId }));
  },

  pinRows(ids, pinned) {
    const s = get();
    const w = listOfTab(s, ids[0] ?? "");
    if (!w) return;
    // Unpinned, they go to the top of the list, below anything pinned.
    const beforeId = pinned ? null : w.tabIds.find((id) => !inPinnedContainer(s, id) && !ids.includes(id));
    set(placing(s, ids, { pinned: false, row: pinned, beforeId }));
  },

  returnToPinnedUrl(tabId) {
    const t = get().tabs[tabId];
    if (!t?.pinnedUrl || samePage(t.url, t.pinnedUrl)) return;
    get().navigate(tabId, t.pinnedUrl);
  },

  setPinnedUrl(tabId, url) {
    const t = get().tabs[tabId];
    const next = url ?? t?.url;
    if (!t || !pinnedPage(t) || !next) return;
    get().updateTab(tabId, { pinnedUrl: next });
    if (url && !samePage(t.url, url)) get().navigate(tabId, url);
  },

  setMuted(ids, muted) {
    set((s) => {
      const tabs = { ...s.tabs };
      let changed = false;
      for (const id of ids) {
        const t = tabs[id];
        if (t && t.muted !== muted) {
          tabs[id] = { ...t, muted };
          changed = true;
        }
      }
      return changed ? { tabs } : {};
    });
  },

  setSiteMuted(tabId, muted) {
    const s = get();
    const tab = s.tabs[tabId];
    if (!tab) return;
    const host = hostOf(tab.url);
    if (!host) return get().setMuted([tabId], muted);
    get().setMuted(
      Object.values(s.tabs)
        .filter((t) => t.spaceId === tab.spaceId && hostOf(t.url) === host)
        .map((t) => t.id),
      muted,
    );
    if (isIncognitoSpace(tab.spaceId)) {
      const own = { ...s.privateSiteMutes[tab.windowId], [host]: muted };
      return set({ privateSiteMutes: { ...get().privateSiteMutes, [tab.windowId]: own } });
    }
    const sites = new Set(s.settings.mutedSites ?? []);
    if (muted) sites.add(host);
    else sites.delete(host);
    get().updateSettings({ mutedSites: [...sites] });
  },

  groupTabs(ids, { pinned = true, name } = {}) {
    const [next, id] = withGroup(get(), ids, { pinned, name });
    if (!id) return id;
    // The windows that had them selected select nothing.
    const selection = Object.fromEntries(Object.entries(next.selection).map(([w, sel]) => [w, sel.some((t) => ids.includes(t)) ? [] : sel]));
    set({ ...next, selection });
    return id;
  },

  moveGroup(groupId, p) {
    set((s) => {
      const g = s.groups[groupId];
      const w = g?.tabIds[0] ? listOfTab(s, g.tabIds[0]) : undefined;
      if (!g || !w || (p.beforeId && g.tabIds.includes(p.beforeId))) return {};
      const groups = { ...s.groups, [groupId]: { ...g, pinned: p.pinned } };
      const rest = w.tabIds.filter((id) => !g.tabIds.includes(id));
      let at: number;
      if (p.beforeId && rest.includes(p.beforeId)) {
        const other = groupOf({ groups }, p.beforeId);
        at = rest.indexOf(other ? other.tabIds.find((id) => rest.includes(id))! : p.beforeId);
      } else if (p.pinned) {
        const pinnedGroup = new Set(
          Object.values(groups)
            .filter((x) => x.pinned && x.id !== groupId)
            .flatMap((x) => x.tabIds),
        );
        at = rest.reduce((last, id, i) => (s.tabs[id]?.pinned || pinnedGroup.has(id) ? i + 1 : last), 0);
      } else at = rest.length;
      rest.splice(at, 0, ...g.tabIds);
      const list = { key: w.key, tabIds: orderSections(rest, s.tabs, groups, s.pinnedFolders) };
      return { groups: syncGroupOrder(groups, list), tabLists: withList(s, list).tabLists };
    });
  },

  duplicateGroup(groupId) {
    let s = get();
    const g = s.groups[groupId];
    const windowId = g && groupWindow(s, g);
    const list = g?.tabIds[0] ? listOfTab(s, g.tabIds[0]) : undefined;
    if (!g || !windowId || !list) return "";
    const after = list.tabIds.indexOf(g.tabIds.at(-1)!) + 1;
    const [restored, ids] = restoreSnapshots(
      s,
      windowId,
      g.tabIds.map((id, i) => ({ tab: { ...snapshotTab(s.tabs[id]!), pinned: false }, index: after + i })),
    );
    let groupId2: string;
    [s, groupId2] = withGroup(restored, ids, { name: g.name, pinned: g.pinned });
    if (groupId2) s = { ...s, groups: { ...s.groups, [groupId2]: { ...s.groups[groupId2]!, icon: g.icon, color: g.color } } };
    set(s);
    return groupId2;
  },

  newTabInGroup(groupId, url) {
    const s = get();
    const g = s.groups[groupId];
    const windowId = g && groupWindow(s, g);
    const list = g?.tabIds[0] ? listOfTab(s, g.tabIds[0]) : undefined;
    if (!g || !windowId || !list) return "";
    const index = list.tabIds.indexOf(g.tabIds.at(-1)!) + 1;
    if (url) {
      const id = get().newTab(windowId, { url, spaceId: g.spaceId, index });
      if (!id) return "";
      const next = get();
      const group = next.groups[groupId];
      if (!group) return id;
      const groups = { ...next.groups, [groupId]: { ...group, collapsed: false, tabIds: [...group.tabIds, id] } };
      set({ groups: syncGroupOrder(groups, listOfTab(next, id)!) });
      return id;
    }
    const [next, id] = withNewTab(s, windowId, { spaceId: g.spaceId, index });
    const groups = { ...next.groups, [groupId]: { ...g, collapsed: false, tabIds: [...g.tabIds, id] } };
    set({ ...next, groups: syncGroupOrder(groups, listOfTab(next, id)!) });
    return id;
  },

  moveGroupToBookmarksBar(groupId) {
    const s = get();
    const g = s.groups[groupId];
    if (!g) return;
    const spaceId = isIncognitoSpace(g.spaceId) ? s.settings.defaultSpaceId : g.spaceId;
    const folder = get().addBookmarkFolder({ spaceId, title: groupLabel(s, g) });
    for (const id of g.tabIds) {
      const t = s.tabs[id];
      if (t?.url) get().addBookmark({ spaceId, url: t.url, title: t.customTitle || t.title || t.url, favicon: t.favicon, parentId: folder });
    }
    set(closingGroup(get(), groupId));
  },

  cleanUpTabs(windowId, options = {}) {
    const s = get();
    const spaceId = options.spaceId ?? s.windows[windowId]?.spaceId ?? "";
    const hours = cleanUpHours(s, spaceId);
    const ids = cleanUpCandidates(s, windowId, options.inactiveForMs ?? (hours ? hours * 3_600_000 : CLEAN_UP_AFTER_MS), Date.now(), spaceId);
    if (!ids.length) return 0;
    const entries = closedEntries(s, ids);
    const next = closeQuietly(s, ids);
    if (s.windows[windowId]?.incognito) {
      const own = [...(next.privateCleanedTabs[windowId] ?? []), ...entries].slice(-MAX_CLEANED);
      set({ ...next, privateCleanedTabs: { ...next.privateCleanedTabs, [windowId]: own } });
    } else {
      set({ ...next, cleanedTabs: [...next.cleanedTabs, ...entries].slice(-MAX_CLEANED) });
    }
    return ids.length;
  },

  cleanUpInactiveTabs() {
    let count = 0;
    const s = get();
    // Every space, through a main window (the list is the space's, whichever window); a private window its own.
    const main = s.windowOrder.find((id) => !s.windows[id]!.incognito && s.windows[id]!.kind !== "small");
    const runs = [
      ...(main ? s.spaceOrder.map((spaceId) => [main, spaceId] as const) : []),
      ...Object.values(s.windows)
        .filter((w) => w.incognito)
        .map((w) => [w.id, w.spaceId] as const),
    ];
    for (const [windowId, spaceId] of runs) {
      const hours = cleanUpHours(get(), spaceId);
      if (hours !== null && get().windows[windowId]) count += get().cleanUpTabs(windowId, { inactiveForMs: hours * 3_600_000, spaceId });
    }
    return count;
  },

  restoreCleaned(entryId, fromWindowId) {
    const s = get();
    const privateId =
      fromWindowId && s.windows[fromWindowId]?.incognito
        ? fromWindowId
        : Object.keys(s.privateCleanedTabs).find((id) => !!entryId && s.privateCleanedTabs[id]!.some((c) => c.id === entryId));
    const list = privateId ? (s.privateCleanedTabs[privateId] ?? []) : s.cleanedTabs;
    const entries = list.filter((c) => !entryId || c.id === entryId);
    if (!entries.length) return;
    const left = list.filter((c) => !entries.includes(c));
    let next: BrowserState = privateId ? { ...s, privateCleanedTabs: { ...s.privateCleanedTabs, [privateId]: left } } : { ...s, cleanedTabs: left };
    let restoredId: string | undefined;
    for (const e of entries) {
      // A private tab only ever goes back to its own private window.
      const windowId = privateId ? (next.windows[privateId]?.incognito ? privateId : undefined) : restoreTarget(next, e.windowId);
      if (!windowId || (isIncognitoSpace(e.tab.spaceId) && e.windowId !== windowId)) continue;
      const [restored, [id]] = restoreSnapshots(next, windowId, [{ tab: e.tab, index: windowId === e.windowId ? e.index : undefined }]);
      next = restored;
      const g = e.group && next.groups[e.group.id];
      const w = id ? listOfTab(next, id) : undefined;
      if (id && g && w && g.spaceId === next.tabs[id]!.spaceId) {
        const members = [...g.tabIds, id];
        const list = {
          key: w.key,
          tabIds: placeBlock(
            w.tabIds,
            w.tabIds.filter((t) => members.includes(t)),
          ),
        };
        next = { ...withList(next, list), groups: syncGroupOrder({ ...next.groups, [g.id]: { ...g, tabIds: members } }, list) };
      }
      if (id && entryId) {
        next = apply(next, activated(next, id, windowId));
        restoredId = id;
      }
    }
    set(next);
    return restoredId;
  },

  closeAbandonedNewTabs() {
    const s = get();
    const abandoned = Object.values(s.windows).flatMap((w) => abandonedNewTabs(s, w.id));
    if (abandoned.length) set(removeTabs(s, abandoned, false));
  },
});
