import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { newId, pinnedPage } from "./model";
import { closingGroup } from "./organize";
import type { BrowserWindow, GroupColor, Tab, TabGroup } from "./types";

export type GroupsSlice = {
  groups: Record<string, TabGroup>;

  createGroup(tabIds: string[], options?: { name?: string; icon?: string | null; color?: GroupColor | null }): string;
  updateGroup(id: string, patch: Partial<Pick<TabGroup, "name" | "icon" | "color" | "collapsed" | "pinned">>): void;
  addTabsToGroup(groupId: string, tabIds: string[]): void;
  removeTabsFromGroup(tabIds: string[]): void;
  ungroup(groupId: string): void;
  closeGroup(groupId: string): void;
  deleteGroup(groupId: string): void;
};

export function syncGroupOrder(groups: Record<string, TabGroup>, window: BrowserWindow): Record<string, TabGroup> {
  let changed = false;
  const next = { ...groups };
  for (const g of Object.values(groups)) {
    if (g.windowId !== window.id) continue;
    const members = new Set(g.tabIds);
    const tabIds = window.tabIds.filter((id) => members.has(id));
    if (tabIds.some((id, i) => id !== g.tabIds[i])) {
      next[g.id] = { ...g, tabIds };
      changed = true;
    }
  }
  return changed ? next : groups;
}

// The Essentials, the pinned rows (each folder's together), the pinned groups, then the rest.
export function orderSections(ids: string[], tabs: Record<string, Tab>, groups: Record<string, TabGroup>): string[] {
  const pinnedGroup = new Set(Object.values(groups).filter((g) => g.pinned).flatMap((g) => g.tabIds));
  const rank = (id: string) => {
    if (tabs[id]?.pinned) return 0;
    if (tabs[id]?.pinnedRow) return 1;
    if (pinnedGroup.has(id)) return 2;
    return 3;
  };
  const out = placeFolders([0, 1, 2, 3].flatMap((r) => ids.filter((id) => rank(id) === r)), tabs);
  return out.every((id, i) => id === ids[i]) ? ids : out;
}

/** Each pinned folder's rows together, where its first one is. */
export function placeFolders(ids: string[], tabs: Record<string, Tab>): string[] {
  let out = ids;
  const done = new Set<string>();
  for (const id of ids) {
    const folderId = tabs[id]?.pinnedRow ? tabs[id]!.folderId : undefined;
    if (!folderId || done.has(folderId)) continue;
    done.add(folderId);
    out = placeBlock(out, out.filter((t) => tabs[t]?.pinnedRow && tabs[t]!.folderId === folderId));
  }
  return out;
}

export function placeBlock(tabIds: string[], block: string[]): string[] {
  const members = new Set(block);
  const at = tabIds.findIndex((id) => members.has(id));
  const rest = tabIds.filter((id) => !members.has(id));
  const before = tabIds.slice(0, at).filter((id) => !members.has(id)).length;
  rest.splice(before, 0, ...block);
  return rest;
}

export function leaveGroups(groups: Record<string, TabGroup>, ids: Set<string>): Record<string, TabGroup> {
  if (!Object.values(groups).some((g) => g.tabIds.some((id) => ids.has(id)))) return groups;
  const next: Record<string, TabGroup> = {};
  for (const g of Object.values(groups)) {
    const tabIds = g.tabIds.filter((id) => !ids.has(id));
    if (tabIds.length === g.tabIds.length) next[g.id] = g;
    else if (tabIds.length > (g.autoUngroup ? 1 : 0)) next[g.id] = { ...g, tabIds };
  }
  return next;
}

export const createGroupsSlice: StateCreator<BrowserState, [], [], GroupsSlice> = (set, get) => ({
  groups: {},

  createGroup(tabIds, options = {}) {
    const s = get();
    const tabs = tabIds.map((id) => s.tabs[id]).filter((t) => t && !pinnedPage(t));
    const first = tabs[0];
    if (!first || tabs.some((t) => t!.windowId !== first.windowId || t!.spaceId !== first.spaceId)) return "";
    const w = s.windows[first.windowId]!;
    const members = new Set(tabs.map((t) => t!.id));
    const window = { ...w, tabIds: placeBlock(w.tabIds, w.tabIds.filter((id) => members.has(id))) };
    const group: TabGroup = {
      id: newId("g"),
      windowId: w.id,
      spaceId: first.spaceId,
      name: options.name ?? "",
      icon: options.icon ?? null,
      color: options.color ?? null,
      collapsed: false,
      pinned: false,
      tabIds: window.tabIds.filter((id) => members.has(id)),
      createdAt: Date.now(),
    };
    set({ groups: { ...leaveGroups(s.groups, members), [group.id]: group }, windows: { ...s.windows, [w.id]: window } });
    return group.id;
  },

  updateGroup(id, patch) {
    set((s) => {
      const g = s.groups[id];
      if (!g) return {};
      const groups = { ...s.groups, [id]: { ...g, ...patch } };
      const w = s.windows[g.windowId];
      if (patch.pinned === undefined || patch.pinned === g.pinned || !w) return { groups };
      const window = { ...w, tabIds: orderSections(w.tabIds, s.tabs, groups) };
      return { groups: syncGroupOrder(groups, window), windows: { ...s.windows, [w.id]: window } };
    });
  },

  addTabsToGroup(groupId, tabIds) {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return {};
      const adding = tabIds.filter((id) => {
        const t = s.tabs[id];
        return t && !pinnedPage(t) && t.windowId === group.windowId && t.spaceId === group.spaceId && !group.tabIds.includes(id);
      });
      if (!adding.length) return {};
      const w = s.windows[group.windowId]!;
      const window = { ...w, tabIds: placeBlock(w.tabIds, [...group.tabIds, ...adding]) };
      // A new map: leaveGroups returns the current one when no added tab was in a group.
      const groups = { ...leaveGroups(s.groups, new Set(adding)), [groupId]: { ...group, tabIds: [...group.tabIds, ...adding] } };
      return { groups, windows: { ...s.windows, [w.id]: window } };
    });
  },

  removeTabsFromGroup(tabIds) {
    set((s) => {
      const leaving = new Set(tabIds);
      const groups: Record<string, TabGroup> = {};
      const windows = { ...s.windows };
      for (const g of Object.values(s.groups)) {
        const kept = g.tabIds.filter((id) => !leaving.has(id));
        if (kept.length === g.tabIds.length) {
          groups[g.id] = g;
          continue;
        }
        if (!kept.length) continue;
        const w = windows[g.windowId]!;
        const out = g.tabIds.filter((id) => leaving.has(id));
        const tabIds = w.tabIds.filter((id) => !out.includes(id));
        tabIds.splice(tabIds.indexOf(kept.at(-1)!) + 1, 0, ...out);
        windows[g.windowId] = { ...w, tabIds };
        groups[g.id] = { ...g, tabIds: kept };
      }
      return { groups, windows };
    });
  },

  ungroup(groupId) {
    set((s) => {
      const { [groupId]: _, ...groups } = s.groups;
      return { groups };
    });
  },

  closeGroup(groupId) {
    set(closingGroup(get(), groupId));
  },

  deleteGroup(groupId) {
    set(closingGroup(get(), groupId, true));
  },
});
