// Where rows sit in the sidebar's list, from the store alone: rows are fixed-height, so a row's place is known before
// it mounts or lays out. GroupBlock and Fold draw groups by these numbers; revealing a tab scrolls by them.
import { sidebarMetrics } from "../../lib/sidebarDensity";
import { layout } from "../../lib/constants";
import type { BrowserProjection as BrowserState } from "../../runtime/projection";
import { folderTabIds } from "../../store/folders";
import { activeTabId, spaceFolded } from "../../store/model";
import { GROUP_BORDER, GROUP_PAD, NEW_TAB_GAP } from "./constants";
import { folderEntries, groupEntries, sidebarEntries } from "./entries";

const GAP = layout.rowGap;

export type Section = "pinned" | "pinnedGroups" | "list";

// The entry of a group that holds the window's active tab: it stays out while the group is collapsed.
export function keptEntry(s: BrowserState, windowId: string, spaceId: string, entries: string[]): string | null {
  const active = activeTabId(s, windowId, spaceId);
  if (!active) return null;
  return (
    entries.find(
      (e) =>
        e === `t:${active}` ||
        (e.startsWith("s:") && !!s.splits[e.slice(2)]?.tabIds.includes(active)) ||
        (e.startsWith("f:") && folderTabIds(s, e.slice(2)).includes(active)),
    ) ?? null
  );
}

// A group's members: every row open; only the kept one collapsed (none: nothing, its padding included).
function membersHeight(s: BrowserState, windowId: string, spaceId: string, groupId: string): number {
  const ROW = sidebarMetrics(s.settings.density).rowHeight;
  const entries = groupEntries(s, groupId);
  if (!s.groups[groupId]?.collapsed) return entries.length ? entries.length * ROW + (entries.length - 1) * GAP + GROUP_PAD : GROUP_PAD;
  return keptEntry(s, windowId, spaceId, entries) ? ROW + GROUP_PAD : 0;
}

// A pinned folder's rows below its header: every row open, each after a gap (an open empty one: its "Drag tabs here"
// line); only the kept one collapsed.
function folderMembersHeight(s: BrowserState, windowId: string, spaceId: string, folderId: string): number {
  const ROW = sidebarMetrics(s.settings.density).rowHeight;
  const entries = folderEntries(s, folderId);
  if (!s.pinnedFolders[folderId]?.collapsed) return entries.length ? entriesHeight(s, windowId, spaceId, entries) + GAP : ROW + GAP;
  return keptEntry(s, windowId, spaceId, entries) ? ROW + GAP : 0;
}

/** A list entry's height: a tab or split row, a pinned folder (its header and rows), or a group block (its border, header and members). */
export function entryHeight(s: BrowserState, windowId: string, spaceId: string, entry: string): number {
  const ROW = sidebarMetrics(s.settings.density).rowHeight;
  if (entry.startsWith("f:")) return ROW + folderMembersHeight(s, windowId, spaceId, entry.slice(2));
  if (!entry.startsWith("g:")) return ROW;
  return GROUP_BORDER * 2 + ROW + membersHeight(s, windowId, spaceId, entry.slice(2));
}

/** The room `entries` take in a list (gaps between them included). */
export function entriesHeight(s: BrowserState, windowId: string, spaceId: string, entries: string[]): number {
  return entries.reduce((sum, e) => sum + entryHeight(s, windowId, spaceId, e) + GAP, 0) - (entries.length ? GAP : 0);
}

/**
 * The row showing `tabId` in its section, from the section's top; null for a pinned tile or a live folder's row.
 * `newTabAtTop`: the list starts with the New Tab row.
 */
export function rowSpan(
  s: BrowserState,
  windowId: string,
  spaceId: string,
  tabId: string,
  newTabAtTop: boolean,
): { section: Section; top: number; height: number } | null {
  const ROW = sidebarMetrics(s.settings.density).rowHeight;
  const folded = spaceFolded(s, spaceId);
  const { pinned, pinnedGroups, list } = sidebarEntries(s, windowId, spaceId);
  const sections: [Section, string[], number][] = [
    ["pinned", folded ? [] : pinned, 0],
    ["pinnedGroups", folded ? [] : pinnedGroups.map((id) => `g:${id}`), 0],
    ["list", list, newTabAtTop ? ROW + NEW_TAB_GAP : 0],
  ];
  for (const [section, entries, start] of sections) {
    let top = start;
    for (const entry of entries) {
      const id = entry.slice(2);
      if (entry === `t:${tabId}` || (entry.startsWith("s:") && s.splits[id]?.tabIds.includes(tabId))) return { section, top, height: ROW };
      if (entry.startsWith("f:") && folderTabIds(s, id).includes(tabId)) {
        return { section, ...folderRowSpan(s, windowId, spaceId, id, tabId, top) };
      }
      if (entry.startsWith("g:") && s.groups[id]?.tabIds.includes(tabId)) {
        const members = groupEntries(s, id);
        const at = members.findIndex((e) => e === `t:${tabId}` || (e.startsWith("s:") && !!s.splits[e.slice(2)]?.tabIds.includes(tabId)));
        const header = top + GROUP_BORDER;
        if (s.groups[id]!.collapsed) {
          // A collapsed group shows only the kept row; any other member is behind its header.
          const kept = keptEntry(s, windowId, spaceId, members) === members[at];
          return kept ? { section, top: header + ROW, height: ROW } : { section, top: header, height: ROW };
        }
        return { section, top: header + ROW + at * (ROW + GAP), height: ROW };
      }
      top += entryHeight(s, windowId, spaceId, entry) + GAP;
    }
  }
  return null;
}

// Follow the same nested rows that FolderBlock renders. A hidden leaf reveals its nearest closed header.
function folderRowSpan(s: BrowserState, windowId: string, spaceId: string, folderId: string, tabId: string, top: number): { top: number; height: number } {
  const ROW = sidebarMetrics(s.settings.density).rowHeight;
  const entries = folderEntries(s, folderId);
  const kept = keptEntry(s, windowId, spaceId, entries);
  if (s.pinnedFolders[folderId]?.collapsed) {
    return { top: activeTabId(s, windowId, spaceId) === tabId && kept ? top + ROW + GAP : top, height: ROW };
  }
  let nextTop = top + ROW + GAP;
  for (const entry of entries) {
    if (entry === `t:${tabId}` || (entry.startsWith("s:") && s.splits[entry.slice(2)]?.tabIds.includes(tabId))) return { top: nextTop, height: ROW };
    if (entry.startsWith("f:") && folderTabIds(s, entry.slice(2)).includes(tabId)) return folderRowSpan(s, windowId, spaceId, entry.slice(2), tabId, nextTop);
    nextTop += entryHeight(s, windowId, spaceId, entry) + GAP;
  }
  return { top, height: ROW };
}

/**
 * Where the window's tab is when it's scrolled out of the sidebar's view (Arc's overflow indicator): "above" or
 * "below", or null while any of it shows. `row` is in the list's content (from its top, glow room included), `top`
 * the list's scroll offset; rows under the header's glow room (`glowRoom`) are hidden.
 */
export function offscreenSide(row: { y: number; height: number }, top: number, viewport: number, glowRoom: number): "above" | "below" | null {
  if (viewport <= 0) return null;
  if (row.y + row.height <= top + glowRoom) return "above";
  if (row.y >= top + viewport) return "below";
  return null;
}

/** Closed folders can keep selected children mounted; their measured frames are not visible drop targets. */
export function folderDragItemVisible(s: BrowserState, windowId: string, item: { kind: string; parentGroup?: string; tabIds: readonly string[] }): boolean {
  let parent = item.parentGroup ? s.pinnedFolders[item.parentGroup] : undefined;
  while (parent) {
    if (parent.collapsed) {
      const active = activeTabId(s, windowId);
      return (item.kind === "row" || item.kind === "split") && !!active && item.tabIds.includes(active);
    }
    parent = parent.parentId ? s.pinnedFolders[parent.parentId] : undefined;
  }
  return true;
}
