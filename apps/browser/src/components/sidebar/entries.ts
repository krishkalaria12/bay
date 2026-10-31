import { useShallow } from "zustand/react/shallow";
import { useBrowser, type BrowserState } from "../../store/browser";
import { childFolderIds, folderRootId, folderTabIds, inFolder } from "../../store/folders";
import { activeTabId, favoriteTabIds, spaceFolded, viewTabIds } from "../../store/model";
import { live, profileFolders } from "../../live/store";
import { folderRows } from "../../live/rows";
import type { SidebarKeyboardRow } from "./keyboardModel";
import { splitRowTabs } from "../../store/splits";
import { splitIndex, stableList } from "../../store/structure";

// The Essentials (tiles), the Pinned section's rows and folders ("t:" and "f:" entries), the pinned groups, and the
// list.
export type SidebarEntries = { tiles: string[]; pinned: string[]; pinnedGroups: string[]; list: string[] };

const memo = new Map<string, { inputs: unknown[]; result: SidebarEntries }>();

export function sidebarEntries(s: BrowserState, windowId: string, spaceId?: string): SidebarEntries {
  const inputs = [s.tabs, s.tabLists, s.windows, s.groups, s.splits, s.pinnedFolders];
  const key = spaceId ? `${windowId}|${spaceId}` : windowId;
  const cached = memo.get(key);
  if (cached && cached.inputs.every((v, i) => v === inputs[i])) return cached.result;
  let result = computeEntries(s, windowId, spaceId);
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

function computeEntries(s: BrowserState, windowId: string, spaceId?: string): SidebarEntries {
  // Favourites are shared by the spaces with this space's profile: theirs show here too.
  const tiles = favoriteTabIds(s, windowId, spaceId);
  const pinned: string[] = [];
  const pinnedGroups: string[] = [];
  const list: string[] = [];
  const groupOf = new Map<string, string>();
  for (const g of Object.values(s.groups)) g.tabIds.forEach((id) => groupOf.set(id, g.id));
  const splits = splitIndex(s.splits);
  const seen = new Set<string>();
  for (const id of viewTabIds(s, windowId, spaceId)) {
    const tab = s.tabs[id]!;
    if (tab.pinned) continue;
    if (tab.pinnedRow) {
      const folder = tab.folderId ? s.pinnedFolders[tab.folderId] : undefined;
      const rootId = folder && inFolder(tab, folder) ? folderRootId(s, folder.id) : undefined;
      const entry = rootId ? `f:${rootId}` : splitEntry(s, id, splits);
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
  // Empty folders retain explicit drag anchors; old folders without one remain after populated rows.
  const profile = spaceId ?? s.windows[windowId]?.spaceId;
  const roots = childFolderIds(s, null, profile);
  insertEmptyFolders(
    s,
    pinned,
    roots.filter((id) => !seen.has(`f:${id}`)),
  );

  return { tiles, pinned, pinnedGroups, list };
}

export function numberedTabs(s: BrowserState, windowId: string): string[] {
  const { tiles, pinned, pinnedGroups, list } = sidebarEntries(s, windowId);
  const active = activeTabId(s, windowId);
  const rowTab = (entry: string): string[] => {
    const id = entry.slice(2);
    if (entry.startsWith("g:")) return groupEntries(s, id).flatMap(rowTab);
    if (entry.startsWith("f:")) return folderEntries(s, id).flatMap(rowTab);
    if (!entry.startsWith("s:")) return [id];
    const panes = s.splits[id] ? splitRowTabs(s, s.splits[id]) : [];
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
    if (entry.startsWith("f:")) return folderEntries(s, id).flatMap(rowTabs);
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
    const panes = splitRowTabs(s, v);
    if (panes.length >= 2 && panes.includes(tabId)) return `s:${v.id}`;
  }
  return `t:${tabId}`;
}

export function useSidebarEntries(windowId: string, spaceId?: string): SidebarEntries {
  return useBrowser((s) => sidebarEntries(s, windowId, spaceId));
}

export const useGroupEntries = (groupId: string) => useBrowser(useShallow((s) => groupEntries(s, groupId)));

const folderMemo = new Map<
  string,
  { tabs: BrowserState["tabs"]; lists: BrowserState["tabLists"]; folders: BrowserState["pinnedFolders"]; splits: BrowserState["splits"]; result: string[] }
>();

/** A folder's immediate tabs and child folders in sidebar order. */
export function folderEntries(s: BrowserState, folderId: string): string[] {
  const cached = folderMemo.get(folderId);
  const folder = s.pinnedFolders[folderId];
  if (cached && cached.tabs === s.tabs && cached.lists === s.tabLists && cached.folders === s.pinnedFolders && cached.splits === s.splits) return cached.result;
  const out: string[] = [];
  if (folder) {
    const children = childFolderIds(s, folderId, folder.spaceId);
    const childForTab = new Map<string, string>();
    for (const child of children) for (const id of folderTabIds(s, child)) childForTab.set(id, child);
    const seen = new Set<string>();
    for (const id of folderTabIds(s, folderId)) {
      const child = childForTab.get(id);
      const entry = child ? `f:${child}` : splitEntry(s, id);
      if (!seen.has(entry)) out.push(entry);
      seen.add(entry);
    }
    insertEmptyFolders(
      s,
      out,
      children.filter((id) => !seen.has(`f:${id}`)),
    );
  }
  const result = stableList(cached?.result, out);
  if (folder) folderMemo.set(folderId, { tabs: s.tabs, lists: s.tabLists, folders: s.pinnedFolders, splits: s.splits, result });
  else folderMemo.delete(folderId);
  return result;
}

export const useFolderEntries = (folderId: string) => useBrowser((s) => folderEntries(s, folderId));

/** Resolve an empty folder's stored anchor to an immediate entry in its parent. */
function insertEmptyFolders(s: BrowserState, entries: string[], emptyIds: string[]) {
  const pending = new Set(emptyIds);
  const keys = new Set([...entries, ...emptyIds.map((id) => `f:${id}`)]);
  const anchorOf = (id: string): string | null => {
    const before = s.pinnedFolders[id]?.beforeId;
    if (!before) return null;
    if (keys.has(`t:${before}`)) return `t:${before}`;
    let folder = s.pinnedFolders[before] ?? s.pinnedFolders[s.tabs[before]?.folderId ?? ""];
    const visited = new Set<string>([id]);
    while (folder && !visited.has(folder.id)) {
      visited.add(folder.id);
      if (keys.has(`f:${folder.id}`)) return `f:${folder.id}`;
      folder = folder.parentId ? s.pinnedFolders[folder.parentId] : undefined;
    }
    return null;
  };
  while (pending.size) {
    let placed = false;
    for (const id of pending) {
      const anchor = anchorOf(id);
      if (anchor?.startsWith("f:") && pending.has(anchor.slice(2))) continue;
      const at = anchor ? entries.indexOf(anchor) : -1;
      entries.splice(at < 0 ? entries.length : at, 0, `f:${id}`);
      pending.delete(id);
      placed = true;
    }
    // Broken or cyclic remote anchors must never hide a folder.
    if (!placed) {
      for (const id of pending) entries.push(`f:${id}`);
      break;
    }
  }
}

/** The settled visible rows, in the same order as SidebarPage, FolderBlock, GroupBlock and LiveFolders. */
export function sidebarKeyboardRows(s: BrowserState, windowId: string, liveState = live(), extensions: SidebarKeyboardRow[] = []): SidebarKeyboardRow[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const active = activeTabId(s, windowId);
  const out: SidebarKeyboardRow[] = [];
  const { tiles, pinned, pinnedGroups, list } = sidebarEntries(s, windowId);
  const append = (entry: string, parentId?: string) => {
    const id = entry.slice(2);
    if (entry.startsWith("f:")) {
      const folder = s.pinnedFolders[id];
      if (!folder) return;
      out.push({ id: entry, kind: "folder", tabIds: folderTabIds(s, id), parentId, collapsed: folder.collapsed });
      if (!folder.collapsed) folderEntries(s, id).forEach((child) => append(child, entry));
      // A collapsed ancestor renders the active leaf directly, bypassing hidden child headers.
      else if (active && folderTabIds(s, id).includes(active)) append(`t:${active}`, entry);
    } else if (entry.startsWith("g:")) {
      const group = s.groups[id];
      if (!group) return;
      out.push({ id: entry, kind: "group", tabIds: group.tabIds, parentId, collapsed: group.collapsed });
      groupEntries(s, id)
        .filter((child) => !group.collapsed || child === `t:${active}` || (child.startsWith("s:") && s.splits[child.slice(2)]?.tabIds.includes(active ?? "")))
        .forEach((child) => append(child, entry));
    } else if (entry.startsWith("s:")) {
      const tabIds = s.splits[id] ? splitRowTabs(s, s.splits[id]) : [];
      if (tabIds.length >= 2) out.push({ id: entry, kind: "split", tabIds, parentId });
    } else if (s.tabs[id]) out.push({ id: entry, kind: "tab", tabIds: [id], parentId });
  };
  tiles.forEach((id) => append(`t:${id}`));
  if (!spaceFolded(s, w.spaceId)) {
    pinned.forEach((entry) => append(entry));
    out.push(...extensions);
    pinnedGroups.forEach((id) => append(`g:${id}`));
  }
  for (const folderId of w.incognito ? [] : profileFolders(liveState, w.spaceId)) {
    const folder = liveState.folders[folderId]!;
    const header = `livefolder|${folderId}`;
    const items = liveState.items[folderId] ?? [];
    const activeItem = active && s.tabs[active]?.liveItem?.folderId === folderId ? s.tabs[active]?.liveItem?.itemId : undefined;
    const itemTabs = (itemId: string) =>
      viewTabIds(s, windowId).filter((id) => s.tabs[id]?.liveItem?.folderId === folderId && s.tabs[id]?.liveItem?.itemId === itemId);
    out.push({ id: header, kind: "liveFolder", tabIds: [], folderId, item: items[0], collapsed: folder.collapsed });
    const appendItem = (item: (typeof items)[number], parentId: string) => {
      if (!liveState.completing[folderId]?.includes(item.id))
        out.push({ id: `live|${folderId}|${item.id}`, kind: "liveItem", tabIds: itemTabs(item.id), folderId, item, parentId });
    };
    for (const row of folderRows(folder, items, liveState.showAll)) {
      if (
        folder.collapsed &&
        !(row.kind === "item" && row.item.id === activeItem) &&
        !(row.kind === "stack" && row.items.some((item) => item.id === activeItem))
      )
        continue;
      if (row.kind === "item") appendItem(row.item, header);
      else if (row.kind === "stack") {
        const stackId = `stack|${folderId}|${row.id}`;
        const collapsed = liveState.expandedStacks[row.id] === false;
        out.push({ id: stackId, kind: "stack", tabIds: [], folderId, item: row.items[0], section: row.id, collapsed, parentId: header });
        if (!collapsed) row.items.forEach((item) => appendItem(item, stackId));
      } else if (row.kind === "more")
        out.push({ id: `more|${folderId}|${row.section}`, kind: "more", tabIds: [], folderId, section: row.section, parentId: header });
    }
    for (const id of viewTabIds(s, windowId)) {
      const tab = s.tabs[id]!;
      if (tab.liveItem?.folderId === folderId && !items.some((item) => item.id === tab.liveItem!.itemId) && (!folder.collapsed || id === active))
        append(`t:${id}`, header);
    }
  }
  list.forEach((entry) => append(entry));
  return out;
}
