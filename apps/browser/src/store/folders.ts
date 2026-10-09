import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { orderSections, syncGroupOrder } from "./groups";
import { newId, without } from "./model";
import { placing } from "./organize";
import type { PinnedFolder, Tab } from "./types";

// The Pinned section's folders (Arc's and Zen's): rows pinned below the Essentials, gathered under a name. A folder
// isn't a group: it holds pinned pages only, it stays when it's emptied, and its members are the tabs that name it.

export type FoldersSlice = {
  pinnedFolders: Record<string, PinnedFolder>;

  /** A folder in the window's space, at the end of its Pinned section; `tabIds` are pinned into it. */
  newPinnedFolder(windowId: string, options?: { tabIds?: string[]; name?: string }): string;
  updatePinnedFolder(id: string, patch: Partial<Pick<PinnedFolder, "name" | "icon" | "collapsed">>): void;
  /** Moves the folder's rows before `beforeId` (a pinned row), or to the end of the Pinned section. */
  movePinnedFolder(id: string, beforeId: string | null): void;
  /** The folder goes; its rows stay pinned, loose, where they were. */
  deletePinnedFolder(id: string): void;
};

/** The folder's rows, in the window's order. */
export function folderTabIds(s: Pick<BrowserState, "tabs" | "windows" | "pinnedFolders">, folderId: string): string[] {
  const f = s.pinnedFolders[folderId];
  const w = f && s.windows[f.windowId];
  if (!w) return [];
  return w.tabIds.filter((id) => inFolder(s.tabs[id], f));
}

export const inFolder = (t: Tab | undefined, f: PinnedFolder) =>
  !!t?.pinnedRow && t.folderId === f.id && t.windowId === f.windowId && t.spaceId === f.spaceId;

/** Folders of windows that are gone, and members' marks of folders that are gone. */
export function prunePinnedFolders(s: BrowserState): BrowserState {
  const gone = Object.values(s.pinnedFolders).filter((f) => !s.windows[f.windowId]).map((f) => f.id);
  const pinnedFolders = gone.length ? without(s.pinnedFolders, gone) : s.pinnedFolders;
  let tabs = s.tabs;
  for (const t of Object.values(s.tabs)) {
    if (!t.folderId || (t.pinnedRow && pinnedFolders[t.folderId])) continue;
    if (tabs === s.tabs) tabs = { ...s.tabs };
    const { folderId: _, ...rest } = t;
    tabs[t.id] = rest;
  }
  return pinnedFolders === s.pinnedFolders && tabs === s.tabs ? s : { ...s, pinnedFolders, tabs };
}

export const createFoldersSlice: StateCreator<BrowserState, [], [], FoldersSlice> = (set, get) => ({
  pinnedFolders: {},

  newPinnedFolder(windowId, { tabIds = [], name = "" } = {}) {
    const s = get();
    const w = s.windows[windowId];
    if (!w) return "";
    const spaceId = tabIds.map((id) => s.tabs[id]?.spaceId).find(Boolean) ?? w.spaceId;
    const folder: PinnedFolder = { id: newId("pf"), windowId, spaceId, name, icon: null, collapsed: false, createdAt: Date.now() };
    let next: BrowserState = { ...s, pinnedFolders: { ...s.pinnedFolders, [folder.id]: folder } };
    const members = tabIds.filter((id) => next.tabs[id]?.windowId === windowId && next.tabs[id]!.spaceId === spaceId);
    if (members.length) {
      // Where the first of them was, if it was a pinned row; else at the end of the Pinned section.
      const at = w.tabIds.findIndex((id) => members.includes(id));
      const after = w.tabIds.slice(at).find((id) => !members.includes(id));
      const beforeId = s.tabs[w.tabIds[at] ?? ""]?.pinnedRow && after && s.tabs[after]?.pinnedRow ? after : null;
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

  movePinnedFolder(id, beforeId) {
    set((s) => {
      const f = s.pinnedFolders[id];
      const w = f && s.windows[f.windowId];
      if (!f || !w) return {};
      const members = folderTabIds(s, id);
      if (!members.length || (beforeId && members.includes(beforeId))) return {};
      const rest = w.tabIds.filter((t) => !members.includes(t));
      // Before a row of another folder: before that folder.
      const other = beforeId ? s.tabs[beforeId]?.folderId : undefined;
      const anchor = other ? rest.find((t) => s.tabs[t]?.pinnedRow && s.tabs[t]!.folderId === other) : beforeId;
      const at = anchor && rest.includes(anchor) ? rest.indexOf(anchor) : rest.reduce((last, t, i) => (s.tabs[t]?.pinned || s.tabs[t]?.pinnedRow ? i + 1 : last), 0);
      rest.splice(at, 0, ...members);
      const window = { ...w, tabIds: orderSections(rest, s.tabs, s.groups) };
      return { windows: { ...s.windows, [w.id]: window }, groups: syncGroupOrder(s.groups, window) };
    });
  },

  deletePinnedFolder(id) {
    set((s) => {
      if (!s.pinnedFolders[id]) return {};
      const tabs = { ...s.tabs };
      for (const t of Object.values(s.tabs)) {
        if (t.folderId !== id) continue;
        const { folderId: _, ...rest } = t;
        tabs[t.id] = rest;
      }
      return { tabs, pinnedFolders: without(s.pinnedFolders, [id]) };
    });
  },
});
