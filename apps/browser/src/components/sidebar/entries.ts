import { useShallow } from "zustand/react/shallow";
import { useBrowser, type BrowserState } from "../../store/browser";
import { folderTabIds, inFolder } from "../../store/folders";
import { activeTabId, favoriteTabIds, pinnedPage, viewTabIds } from "../../store/model";
import { splitIndex, stableList } from "../../store/structure";

// The Essentials (tiles), the Pinned section's rows and folders ("t:" and "f:" entries), the pinned groups, and the
// list.
export type SidebarEntries = { tiles: string[]; pinned: string[]; pinnedGroups: string[]; list: string[] };

const memo = new Map<string, { inputs: unknown[]; result: SidebarEntries }>();

export function sidebarEntries(s: BrowserState, windowId: string, profileId?: string): SidebarEntries {
  const inputs = [s.tabs, s.windows, s.groups, s.splits, s.pinnedFolders];
  const key = profileId ? `${windowId}|${profileId}` : windowId;
  const cached = memo.get(key);
  if (cached && cached.inputs.every((v, i) => v === inputs[i])) return cached.result;
  let result = computeEntries(s, windowId, profileId);
  // Keep the previous object when nothing listed changed (a title or a switch), so subscribers compare by identity.
  if (cached) {
    const was = cached.result;
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
    const tiles = same(result.tiles, was.tiles) ? was.tiles : result.tiles;
    const pinned = same(result.pinned, was.pinned) ? was.pinned : result.pinned;
    const pinnedGroups = same(result.pinnedGroups, was.pinnedGroups) ? was.pinnedGroups : result.pinnedGroups;
    const list = same(result.list, was.list) ? was.list : result.list;
    result =
      tiles === was.tiles && pinned === was.pinned && pinnedGroups === was.pinnedGroups && list === was.list ? was : { tiles, pinned, pinnedGroups, list };
  }
  memo.set(key, { inputs, result });
  // Entries of closed windows would keep their store snapshot alive.
  if (memo.size > 8) for (const k of memo.keys()) if (!s.windows[k.split("|")[0]!]) memo.delete(k);
  return result;
}

function computeEntries(s: BrowserState, windowId: string, profileId?: string): SidebarEntries {
  // Favourites are shared by the spaces with this space's profile: theirs show here too.
  const tiles = favoriteTabIds(s, windowId, profileId);
  const pinned: string[] = [];
  const pinnedGroups: string[] = [];
  const list: string[] = [];
  const groupOf = new Map<string, string>();
  for (const g of Object.values(s.groups)) if (g.windowId === windowId) g.tabIds.forEach((id) => groupOf.set(id, g.id));
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  for (const id of viewTabIds(s, windowId, profileId)) {
    const tab = s.tabs[id]!;
    if (tab.pinned) continue;
    if (tab.pinnedRow) {
      const folder = tab.folderId ? s.pinnedFolders[tab.folderId] : undefined;
      const entry = folder && inFolder(tab, folder) ? `f:${folder.id}` : `t:${id}`;
      if (!seen.has(entry)) pinned.push(entry);
      seen.add(entry);
      continue;
    }
    if (tab.liveItem) continue;
    const groupId = groupOf.get(id);
    const entry = groupId ? `g:${groupId}` : splitEntry(s, id, splits);
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (groupId && s.groups[groupId]!.pinned) pinnedGroups.push(groupId);
    else list.push(entry);
  }
  // A folder with nothing in it still shows, after the rest.
  const profile = profileId ?? s.windows[windowId]?.profileId;
  const empty = Object.values(s.pinnedFolders).filter((f) => f.windowId === windowId && f.profileId === profile && !seen.has(`f:${f.id}`));
  for (const f of empty.sort((a, b) => a.createdAt - b.createdAt)) pinned.push(`f:${f.id}`);
  return { tiles, pinned, pinnedGroups, list };
}

export function numberedTabs(s: BrowserState, windowId: string): string[] {
  const { tiles, pinned, pinnedGroups, list } = sidebarEntries(s, windowId);
  const active = activeTabId(s, windowId);
  const rowTab = (entry: string): string[] => {
    const id = entry.slice(2);
    if (entry.startsWith("g:")) return groupEntries(s, id).flatMap(rowTab);
    if (entry.startsWith("f:")) return folderTabIds(s, id);
    if (!entry.startsWith("s:")) return [id];
    const panes = (s.splits[id]?.tabIds ?? []).filter((tabId) => s.tabs[tabId] && !pinnedPage(s.tabs[tabId]!));
    if (active && panes.includes(active)) return [active];
    const last = panes.reduce<string | undefined>((a, b) => (!a || s.tabs[b]!.lastActiveAt > s.tabs[a]!.lastActiveAt ? b : a), undefined);
    return last ? [last] : [];
  };
  return [...tiles, ...pinned.flatMap(rowTab), ...pinnedGroups.flatMap((id) => rowTab(`g:${id}`)), ...list.flatMap(rowTab)];
}

/**
 * Every tab the sidebar lists, top to bottom: the favourites, then each row's (a folder's or a group's members, a
 * split's panes).
 */
export function sidebarTabOrder(s: BrowserState, windowId: string): string[] {
  const { tiles, pinned, pinnedGroups, list } = sidebarEntries(s, windowId);
  const rowTabs = (entry: string): string[] => {
    const id = entry.slice(2);
    if (entry.startsWith("g:")) return groupEntries(s, id).flatMap(rowTabs);
    if (entry.startsWith("f:")) return folderTabIds(s, id);
    return entry.startsWith("s:") ? (s.splits[id]?.tabIds ?? []) : [id];
  };
  return [...tiles, ...pinned.flatMap(rowTabs), ...pinnedGroups.flatMap((id) => rowTabs(`g:${id}`)), ...list.flatMap(rowTabs)];
}

const groupMemo = new WeakMap<object, { tabs: BrowserState["tabs"]; splits: BrowserState["splits"]; result: string[] }>();

export function groupEntries(s: BrowserState, groupId: string): string[] {
  const g = s.groups[groupId];
  if (!g) return [];
  const cached = groupMemo.get(g);
  if (cached && cached.tabs === s.tabs && cached.splits === s.splits) return cached.result;
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of g.tabIds) {
    const entry = splitEntry(s, id, splits);
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  const result = stableList(cached?.result, out);
  groupMemo.set(g, { tabs: s.tabs, splits: s.splits, result });
  return result;
}

function splitEntry(s: BrowserState, tabId: string, splits = splitIndex(s.splits)): string {
  for (const v of splits.get(tabId) ?? []) {
    if (v.tabIds.filter((id) => s.tabs[id] && !pinnedPage(s.tabs[id]!)).length >= 2) return `s:${v.id}`;
  }
  return `t:${tabId}`;
}

export function useSidebarEntries(windowId: string, profileId?: string): SidebarEntries {
  return useBrowser((s) => sidebarEntries(s, windowId, profileId));
}

export const useGroupEntries = (groupId: string) => useBrowser(useShallow((s) => groupEntries(s, groupId)));

const folderMemo = new Map<string, { tabs: BrowserState["tabs"]; windows: BrowserState["windows"]; folder: unknown; result: string[] }>();

/** A pinned folder's rows, as "t:" entries. */
export function folderEntries(s: BrowserState, folderId: string): string[] {
  const cached = folderMemo.get(folderId);
  const folder = s.pinnedFolders[folderId];
  if (cached && cached.tabs === s.tabs && cached.windows === s.windows && cached.folder === folder) return cached.result;
  const result = stableList(cached?.result, folderTabIds(s, folderId).map((id) => `t:${id}`));
  if (folder) folderMemo.set(folderId, { tabs: s.tabs, windows: s.windows, folder, result });
  else folderMemo.delete(folderId);
  return result;
}

export const useFolderEntries = (folderId: string) => useBrowser((s) => folderEntries(s, folderId));
