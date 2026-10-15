import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { leaveGroups, orderSections, syncGroupOrder } from "./groups";
import { listIds, newId, pinnedPage, spaceListKey, withList, without } from "./model";
import { placing } from "./organize";
import type { PinnedFolder, Tab, TabGroup } from "./types";

export const MAX_FOLDER_DEPTH = 5;
type FolderState = Pick<BrowserState, "pinnedFolders">;
type FolderTabsState = FolderState & Pick<BrowserState, "tabs" | "spaces" | "tabLists">;

type FolderMove = {
  id?: string;
  parentId?: string;
  beforeId?: string;
  spaceId: string;
  tabIds: string[];
  folderIds: string[];
  tabs?: Record<string, Pick<Tab, "pinned" | "pinnedRow" | "folderId" | "pinnedUrl">>;
  groups?: { before: TabGroup; removed: string[] }[];
};

export type FoldersSlice = {
  pinnedFolders: Record<string, PinnedFolder>;
  folderMoveUndo: FolderMove[];
  newPinnedFolder(windowId: string, options?: { tabIds?: string[]; name?: string; parentId?: string; spaceId?: string; beforeId?: string }): string;
  updatePinnedFolder(id: string, patch: Partial<Pick<PinnedFolder, "name" | "icon" | "collapsed">>): void;
  /** Moves the whole subtree. Omit parentId to keep its parent, or pass null to move to the root. */
  movePinnedFolder(id: string, beforeId: string | null, parentId?: string | null): void;
  undoPinnedFolderMove(): boolean;
  /** Removes the folder, promoting its rows and child folders to its parent. */
  deletePinnedFolder(id: string): void;
};

export function childFolderIds(s: FolderState, parentId: string | null, spaceId?: string): string[] {
  return Object.values(s.pinnedFolders)
    .filter((f) => (f.parentId ?? null) === parentId && (!spaceId || f.spaceId === spaceId))
    .map((f) => f.id);
}

export function folderDepth(s: FolderState, id: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let f = s.pinnedFolders[id]; f; f = f.parentId ? s.pinnedFolders[f.parentId] : undefined) {
    if (seen.has(f.id)) return Infinity;
    seen.add(f.id);
    depth++;
  }
  return depth;
}

export function folderRootId(s: FolderState, id: string): string | undefined {
  let f = s.pinnedFolders[id];
  const seen = new Set<string>();
  while (f?.parentId && s.pinnedFolders[f.parentId] && !seen.has(f.parentId)) {
    seen.add(f.id);
    f = s.pinnedFolders[f.parentId];
  }
  return f?.id;
}

function subtreeIds(s: FolderState, id: string): Set<string> {
  const ids = new Set<string>();
  const visit = (at: string) => {
    if (ids.has(at)) return;
    ids.add(at);
    childFolderIds(s, at).forEach(visit);
  };
  if (s.pinnedFolders[id]) visit(id);
  return ids;
}

export function canMoveFolder(s: FolderState, id: string, parentId: string | null): boolean {
  const f = s.pinnedFolders[id];
  const parent = parentId ? s.pinnedFolders[parentId] : undefined;
  if (!f || (parentId && (!parent || parent.spaceId !== f.spaceId))) return false;
  const subtree = subtreeIds(s, id);
  if (parentId && subtree.has(parentId)) return false;
  const height = Math.max(...[...subtree].map((child) => folderDepth(s, child) - folderDepth(s, id) + 1));
  return (parent ? folderDepth(s, parent.id) : 0) + height <= MAX_FOLDER_DEPTH;
}

/** Rows in list order, including descendants unless recursive is false. */
export function folderTabIds(s: FolderTabsState, folderId: string, recursive = true): string[] {
  const f = s.pinnedFolders[folderId];
  if (!f) return [];
  const folders = recursive ? subtreeIds(s, folderId) : new Set([folderId]);
  return listIds(s, spaceListKey(s, f.spaceId)).filter((id) => {
    const t = s.tabs[id];
    return !!t?.pinnedRow && t.spaceId === f.spaceId && !!t.folderId && folders.has(t.folderId);
  });
}

/** Where an empty folder receives its first rows, following sibling anchors through empty folders. */
export function folderInsertionBeforeId(s: FolderTabsState, folderId: string, excluding: string[] = []): string | null {
  const omitted = new Set(excluding);
  const rows = (id: string) => folderTabIds(s, id).filter((tab) => !omitted.has(tab));
  const seen = new Set<string>();
  const visit = (id: string): string | null => {
    const f = s.pinnedFolders[id];
    if (!f || seen.has(id)) return null;
    seen.add(id);
    const before = f.beforeId;
    if (before) {
      const tab = s.tabs[before];
      if (tab?.spaceId === f.spaceId && tab.pinnedRow && !omitted.has(before) && (tab.folderId ?? null) === (f.parentId ?? null)) return before;
      let sibling = s.pinnedFolders[before] ?? s.pinnedFolders[tab?.folderId ?? ""];
      const ancestors = new Set<string>();
      while (sibling && sibling.spaceId === f.spaceId && (sibling.parentId ?? null) !== (f.parentId ?? null) && !ancestors.has(sibling.id)) {
        ancestors.add(sibling.id);
        sibling = sibling.parentId ? s.pinnedFolders[sibling.parentId] : undefined;
      }
      if (sibling && sibling.id !== id && sibling.spaceId === f.spaceId && (sibling.parentId ?? null) === (f.parentId ?? null)) {
        const first = rows(sibling.id)[0];
        if (first) return first;
        if (!seen.has(sibling.id)) return visit(sibling.id);
      }
    }
    if (f.parentId) {
      const members = rows(f.parentId);
      const last = members.at(-1);
      if (last) {
        const list = listIds(s, spaceListKey(s, f.spaceId)).filter((tab) => !omitted.has(tab));
        return list[list.indexOf(last) + 1] ?? null;
      }
      return visit(f.parentId);
    }
    return null;
  };
  return visit(folderId);
}

export const inFolder = (t: Tab | undefined, f: PinnedFolder) => !!t?.pinnedRow && t.folderId === f.id && t.spaceId === f.spaceId;

/** Repair missing parents, cross-space links, cycles and old flat sessions without dropping rows. */
export function normalizePinnedFolders(folders: Record<string, PinnedFolder>): Record<string, PinnedFolder> {
  let next = folders;
  for (const id of Object.keys(folders).sort()) {
    const f = next[id]!;
    if (!f.parentId) continue;
    const parent = next[f.parentId];
    if (parent && parent.spaceId === f.spaceId && folderDepth({ pinnedFolders: next }, id) <= MAX_FOLDER_DEPTH) continue;
    if (next === folders) next = { ...folders };
    const { parentId: _, ...root } = f;
    next[id] = root;
  }
  return next;
}

export function prunePinnedFolders(s: BrowserState): BrowserState {
  const gone = Object.values(s.pinnedFolders)
    .filter((f) => !s.spaces[f.spaceId])
    .map((f) => f.id);
  const pinnedFolders = normalizePinnedFolders(gone.length ? without(s.pinnedFolders, gone) : s.pinnedFolders);
  let tabs = s.tabs;
  for (const t of Object.values(s.tabs)) {
    if (!t.folderId || (t.pinnedRow && pinnedFolders[t.folderId]?.spaceId === t.spaceId)) continue;
    if (tabs === s.tabs) tabs = { ...s.tabs };
    const { folderId: _, ...rest } = t;
    tabs[t.id] = rest;
  }
  return pinnedFolders === s.pinnedFolders && tabs === s.tabs ? s : { ...s, pinnedFolders, tabs };
}

/** Record only fields changed by placing rows, leaving page state out of undo. */
export function withFolderPlacementUndo(before: BrowserState, after: BrowserState, ids: string[]): BrowserState {
  const first = before.tabs[ids[0] ?? ""];
  if (!first || after === before || !ids.some((id) => before.tabs[id]?.folderId || after.tabs[id]?.folderId)) return after;
  const tabs: NonNullable<FolderMove["tabs"]> = {};
  for (const id of ids) {
    const t = before.tabs[id];
    if (!t || after.tabs[id] === t) continue;
    tabs[id] = { pinned: t.pinned, pinnedRow: t.pinnedRow, folderId: t.folderId, pinnedUrl: t.pinnedUrl };
  }
  if (!Object.keys(tabs).length && before.tabLists === after.tabLists) return after;
  const move: FolderMove = {
    spaceId: first.spaceId,
    tabIds: listIds(before, spaceListKey(before, first.spaceId)),
    folderIds: Object.keys(before.pinnedFolders),
    tabs,
    groups: Object.values(before.groups)
      .filter((g) => g !== after.groups[g.id])
      .map((g) => ({ before: g, removed: g.tabIds.filter((id) => !after.groups[g.id]?.tabIds.includes(id)) })),
  };
  return { ...after, folderMoveUndo: [...before.folderMoveUndo, move].slice(-30) };
}

export const createFoldersSlice: StateCreator<BrowserState, [], [], FoldersSlice> = (set, get) => ({
  pinnedFolders: {},
  folderMoveUndo: [],

  newPinnedFolder(windowId, { tabIds = [], name = "", parentId, spaceId: requestedSpace, beforeId: emptyAnchor } = {}) {
    const s = get();
    const w = s.windows[windowId];
    if (!w) return "";
    const parent = parentId ? s.pinnedFolders[parentId] : undefined;
    if (parentId && (!parent || folderDepth(s, parentId) >= MAX_FOLDER_DEPTH)) return "";
    if (requestedSpace && !s.spaces[requestedSpace]) return "";
    const spaceId = parent?.spaceId ?? requestedSpace ?? tabIds.map((id) => s.tabs[id]?.spaceId).find(Boolean) ?? w.spaceId;
    const folder: PinnedFolder = {
      id: newId("pf"),
      spaceId,
      name,
      icon: null,
      collapsed: false,
      createdAt: Date.now(),
      ...(parentId ? { parentId } : {}),
      ...(emptyAnchor ? { beforeId: emptyAnchor } : {}),
    };
    let next: BrowserState = { ...s, pinnedFolders: { ...s.pinnedFolders, [folder.id]: folder } };
    const members = tabIds.filter((id) => next.tabs[id]?.spaceId === spaceId);
    const list = listIds(s, spaceListKey(s, spaceId));
    if (members.length) {
      const at = list.findIndex((id) => members.includes(id));
      const after = list.slice(at).find((id) => !members.includes(id));
      const beforeId = s.tabs[list[at] ?? ""]?.pinnedRow && after && s.tabs[after]?.pinnedRow ? after : null;
      next = placing(next, members, { pinned: false, row: true, folderId: folder.id, beforeId });
    }
    set(next);
    return folder.id;
  },

  updatePinnedFolder(id, patch) {
    set((s) => {
      const f = s.pinnedFolders[id];
      return f ? { pinnedFolders: { ...s.pinnedFolders, [id]: { ...f, ...patch } } } : {};
    });
  },

  movePinnedFolder(id, beforeId, parentId) {
    set((s) => {
      const f = s.pinnedFolders[id];
      if (!f) return {};
      const targetParent = parentId === undefined ? (f.parentId ?? null) : parentId;
      if (!canMoveFolder(s, id, targetParent)) return {};
      const subtree = subtreeIds(s, id);
      const members = folderTabIds(s, id);
      if (beforeId && (members.includes(beforeId) || subtree.has(beforeId))) return {};
      const { parentId: _, beforeId: _before, ...root } = f;
      const anchorFolder = beforeId ? s.pinnedFolders[beforeId] : undefined;
      const anchorTab = beforeId ? s.tabs[beforeId] : undefined;
      const validAnchor = beforeId && (anchorFolder?.spaceId === f.spaceId || (anchorTab?.spaceId === f.spaceId && anchorTab.pinnedRow));
      const moved = { ...root, ...(targetParent ? { parentId: targetParent } : {}), ...(!members.length && validAnchor ? { beforeId } : {}) };
      // Object order also retains empty sibling order through persistence.
      const others = Object.values(s.pinnedFolders).filter((folder) => folder.id !== id);
      let beforeFolder = beforeId && s.pinnedFolders[beforeId] ? beforeId : beforeId ? s.tabs[beforeId]?.folderId : undefined;
      // A row directly in the target parent is an exact anchor. A descendant row anchors its immediate sibling subtree.
      while (beforeFolder && beforeFolder !== targetParent && (s.pinnedFolders[beforeFolder]?.parentId ?? null) !== targetParent) {
        beforeFolder = s.pinnedFolders[beforeFolder]?.parentId;
      }
      if (beforeFolder === targetParent) beforeFolder = undefined;
      const folderAt = others.findIndex((folder) => folder.id === beforeFolder);
      others.splice(folderAt < 0 ? others.length : folderAt, 0, moved);
      const pinnedFolders = Object.fromEntries(others.map((folder) => [folder.id, folder]));
      const next = { ...s, pinnedFolders };
      const key = spaceListKey(s, f.spaceId);
      const rest = listIds(s, key).filter((t) => !members.includes(t));
      let anchor = beforeId;
      if (beforeFolder) anchor = folderTabIds(next, beforeFolder).find((t) => rest.includes(t)) ?? null;
      let at = anchor && rest.includes(anchor) ? rest.indexOf(anchor) : -1;
      if (at < 0 && targetParent) {
        const siblings = new Set(folderTabIds(next, targetParent));
        at = rest.reduce((last, t, i) => (siblings.has(t) ? i + 1 : last), -1);
        if (at < 0) {
          const emptyAnchor = folderInsertionBeforeId(next, targetParent, members);
          if (emptyAnchor && rest.includes(emptyAnchor)) at = rest.indexOf(emptyAnchor);
        }
      }
      if (at < 0) at = rest.reduce((last, t, i) => (s.tabs[t]?.pinned || s.tabs[t]?.pinnedRow ? i + 1 : last), 0);
      rest.splice(at, 0, ...members);
      const list = { key, tabIds: orderSections(rest, s.tabs, s.groups, pinnedFolders) };
      const folderMoveUndo = [
        ...s.folderMoveUndo,
        { id, parentId: f.parentId, beforeId: f.beforeId, spaceId: f.spaceId, tabIds: listIds(s, key), folderIds: Object.keys(s.pinnedFolders) },
      ].slice(-30);
      return { pinnedFolders, folderMoveUndo, tabLists: withList(s, list).tabLists, groups: syncGroupOrder(s.groups, list) };
    });
  },

  undoPinnedFolderMove() {
    const s = get();
    const history = [...s.folderMoveUndo];
    let move: FolderMove | undefined;
    while ((move = history.pop())) if (!move.id || s.pinnedFolders[move.id]) break;
    if (!move || (move.id && !s.pinnedFolders[move.id])) {
      if (s.folderMoveUndo.length) set({ folderMoveUndo: [] });
      return false;
    }
    const folders = { ...s.pinnedFolders };
    if (move.id) {
      const { parentId: _, beforeId: _before, ...f } = folders[move.id]!;
      const parentId = move.parentId && folders[move.parentId]?.spaceId === f.spaceId ? move.parentId : undefined;
      folders[f.id] = { ...f, ...(parentId ? { parentId } : {}), ...(move.beforeId ? { beforeId: move.beforeId } : {}) };
      if (!canMoveFolder({ pinnedFolders: folders }, f.id, parentId ?? null)) return false;
    }
    const tabs = { ...s.tabs };
    for (const [id, pin] of Object.entries(move.tabs ?? {})) {
      const tab = tabs[id];
      if (!tab || tab.spaceId !== move.spaceId) continue;
      const { pinnedRow: _, folderId: _f, ...rest } = tab;
      const folderId = pin.folderId && folders[pin.folderId]?.spaceId === tab.spaceId ? pin.folderId : undefined;
      tabs[id] = { ...rest, pinned: pin.pinned, pinnedUrl: pin.pinnedUrl, ...(pin.pinnedRow ? { pinnedRow: true } : {}), ...(folderId ? { folderId } : {}) };
    }
    const movedTabs = new Set(Object.keys(move.tabs ?? {}));
    let groups = leaveGroups(s.groups, new Set([...movedTabs].filter((id) => tabs[id] && pinnedPage(tabs[id]!))));
    for (const entry of move.groups ?? []) {
      const restored = entry.removed.filter((id) => {
        const t = tabs[id];
        return t && t.spaceId === entry.before.spaceId && !pinnedPage(t) && (movedTabs.has(id) || !Object.values(groups).some((g) => g.tabIds.includes(id)));
      });
      if (!restored.length) continue;
      groups = leaveGroups(groups, new Set(restored));
      const current = groups[entry.before.id];
      groups = { ...groups, [entry.before.id]: { ...(current ?? entry.before), tabIds: [...new Set([...(current?.tabIds ?? []), ...restored])] } };
    }
    const order = [...move.folderIds.filter((id) => folders[id]), ...Object.keys(folders).filter((id) => !move!.folderIds.includes(id))];
    const pinnedFolders = Object.fromEntries(order.map((id) => [id, folders[id]!]));
    const key = spaceListKey(s, move.spaceId);
    const current = listIds(s, key);
    const prior = move.tabIds.filter((id) => current.includes(id));
    const priorIds = new Set(prior);
    let index = 0;
    const restored = current.map((id) => (priorIds.has(id) ? prior[index++]! : id));
    const list = { key, tabIds: orderSections(restored, tabs, groups, pinnedFolders) };
    set({ tabs, pinnedFolders, folderMoveUndo: history, tabLists: withList(s, list).tabLists, groups: syncGroupOrder(groups, list) });
    return true;
  },

  deletePinnedFolder(id) {
    set((s) => {
      const f = s.pinnedFolders[id];
      if (!f) return {};
      const tabs = { ...s.tabs };
      for (const t of Object.values(s.tabs)) {
        if (t.folderId !== id) continue;
        const { folderId: _, ...rest } = t;
        tabs[t.id] = { ...rest, ...(f.parentId ? { folderId: f.parentId } : {}) };
      }
      const pinnedFolders = without(s.pinnedFolders, [id]);
      for (const child of childFolderIds(s, id)) {
        const { parentId: _, ...rest } = pinnedFolders[child]!;
        pinnedFolders[child] = { ...rest, ...(f.parentId ? { parentId: f.parentId } : {}) };
      }
      return { tabs, pinnedFolders };
    });
  },
});
