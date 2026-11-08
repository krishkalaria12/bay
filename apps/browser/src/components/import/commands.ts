import type { BookmarkNode, DiaTabsProfile, SpaceSuggestion } from "@bay/import";
import { browserRead } from "../../store/read";
import { engineProfileFor, isIncognitoSpace } from "../../store/model";
import { dispatchBrowserCommand } from "../../runtime/commands";
import { addBookmarkFolder, addBookmarkTree } from "../../runtime/bookmarkActions";
import { addTabsToGroup, createGroup, newPinnedFolder, pinRows, placeTabs } from "../../runtime/organizeActions";
import { createWindow } from "../../runtime/windowActions";
import { newTab } from "../../runtime/tabActions";
import {
  IMPORT_PAYLOAD_CHARS,
  IMPORT_TITLE_CHARS,
  pageKey,
  parseImportCommand,
  planArcSpace,
  regularWindowId,
  splitImportedRoots,
  usable,
  type ImportCommand,
  type ImportHistoryEntry,
  type TabDraft,
} from "../../runtime/importCommands";

export function destinationProfile(spaceId: string): string {
  const s = browserRead.getState();
  if (isIncognitoSpace(spaceId) || !Object.hasOwn(s.spaces, spaceId)) throw new Error("The destination space is unavailable");
  return engineProfileFor(spaceId, s.spaces);
}

export async function windowFor(spaceId: string): Promise<string> {
  destinationProfile(spaceId);
  return regularWindowId(browserRead.getState()) ?? createWindow({ spaceId });
}

function fits(command: ImportCommand): boolean {
  try {
    parseImportCommand(command);
    return true;
  } catch {
    return false;
  }
}

// Room in a command for everything around its items.
const COMMAND_ROOM = 1024;
const sendable = (item: unknown) => JSON.stringify(item).length + 1 + COMMAND_ROOM <= IMPORT_PAYLOAD_CHARS;
const wholeTime = (time: number | undefined) => {
  const whole = Math.round(time ?? NaN);
  return Number.isSafeInteger(whole) && whole >= 0 ? whole : undefined;
};

// Bound both the JSON and item count, including strings containing escaped characters.
function* batches<T>(items: readonly T[]): Generator<T[]> {
  let batch: T[] = [];
  let size = COMMAND_ROOM;
  for (const item of items) {
    const chars = JSON.stringify(item).length + 1;
    if (!sendable(item)) throw new Error("An imported item is too large");
    if (batch.length && (batch.length >= 1000 || size + chars > IMPORT_PAYLOAD_CHARS)) {
      yield batch;
      batch = [];
      size = COMMAND_ROOM;
    }
    batch.push(item);
    size += chars;
  }
  if (batch.length) yield batch;
}

const draftTab = ({ url, title, pinned, customTitle }: TabDraft): TabDraft => ({ url, title, pinned, ...(customTitle !== undefined ? { customTitle } : {}) });

async function openTabs(spaceId: string, tabs: TabDraft[]): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (const batch of batches(tabs.map(draftTab))) {
    const result = await dispatchBrowserCommand({ method: "importTabs", spaceId, tabs: batch, group: null, ...(afterId ? { afterId } : {}) });
    ids.push(...result.tabIds!);
    batch.forEach((tab, i) => {
      if (!tab.pinned) afterId = result.tabIds![i];
    });
  }
  return ids;
}

export async function importTabs(spaceId: string, tabs: TabDraft[], group: string | null): Promise<number> {
  const fresh = tabs.filter((tab) => usable(tab) && sendable(draftTab(tab)));
  if (!fresh.length) return 0;
  const ids = await openTabs(spaceId, fresh);
  const unpinned = ids.filter((_, i) => !fresh[i]!.pinned);
  if (group && unpinned.length) {
    let groupId: string | undefined;
    for (const batch of batches(unpinned)) {
      if (groupId) await addTabsToGroup(groupId, batch);
      else groupId = await createGroup(batch, { name: group });
    }
  }
  return ids.length;
}

export async function importHistory(spaceId: string, entries: ImportHistoryEntry[]): Promise<number> {
  let count = 0;
  const data = entries.flatMap(({ url, title, visits, lastVisit }) => {
    const entry = { url, title: title.slice(0, IMPORT_TITLE_CHARS), visits: wholeTime(visits) ?? 1, lastVisit: wholeTime(lastVisit) ?? 0 };
    return sendable(entry) ? [entry] : [];
  });
  for (const batch of batches(data)) count += (await dispatchBrowserCommand({ method: "importHistory", spaceId, entries: batch })).count;
  return count;
}

// A bookmark as the import command takes it. A browser's fractional date or an over-long title can't cost the bookmark,
// and a link too long to send (a huge data: URL) is left out rather than costing all the others.
function cleanBookmark(node: BookmarkNode, onSkipped: () => void): BookmarkNode | null {
  const { dateAdded: _date, ...rest } = node;
  const date = wholeTime(node.dateAdded);
  const clean: BookmarkNode = {
    ...rest,
    title: (node.title ?? "").slice(0, IMPORT_TITLE_CHARS),
    ...(node.pageTitle !== undefined ? { pageTitle: node.pageTitle.slice(0, IMPORT_TITLE_CHARS) } : {}),
    ...(date !== undefined ? { dateAdded: date } : {}),
  };
  if (node.type === "folder") return { ...clean, children: (node.children ?? []).flatMap((child) => cleanBookmark(child, onSkipped) ?? []) };
  if (sendable(clean)) return clean;
  onSkipped();
  return null;
}

export async function importBookmarks(
  spaceId: string,
  imported: BookmarkNode | undefined,
  browserName: string,
  onSkipped?: (count: number) => void,
): Promise<number> {
  if (!imported?.children?.length) return 0;
  let skipped = 0;
  const skip = () => void skipped++;
  const root = cleanBookmark(imported, skip);
  const count = root?.children?.length ? await writeBookmarks(spaceId, root, browserName, skip) : 0;
  if (skipped) onSkipped?.(skipped);
  return count;
}

async function writeBookmarks(spaceId: string, root: BookmarkNode, browserName: string, skip: () => void): Promise<number> {
  const command: ImportCommand = { method: "importBookmarks", spaceId, root, browserName };
  if (fits(command)) return (await dispatchBrowserCommand(command)).count;
  // Large exports are written a folder at a time so native IPC never needs the entire tree.
  await addBookmarkTree(spaceId, []);
  const roots = browserRead.getState().bookmarks.roots[spaceId]!;
  const { toolbar, other } = splitImportedRoots(root.children ?? []);
  let count = 0;
  const write = async (nodes: BookmarkNode[], parentId: string) => {
    const commandFor = (children: BookmarkNode[]): ImportCommand => ({
      method: "importBookmarks",
      spaceId,
      browserName,
      parentId,
      root: { type: "folder", title: "", children },
    });
    let pending: BookmarkNode[] = [];
    const flush = async () => {
      if (!pending.length) return;
      count += (await dispatchBrowserCommand(commandFor(pending))).count;
      pending = [];
    };
    for (const node of nodes) {
      if (pending.length < 1000 && fits(commandFor([...pending, node]))) {
        pending.push(node);
        continue;
      }
      await flush();
      if (fits(commandFor([node]))) pending = [node];
      else if (node.type === "folder") {
        const result = await dispatchBrowserCommand(commandFor([{ ...node, children: [] }]));
        const folder = result.bookmarkIds?.[0];
        if (!folder) throw new Error("The imported folder was not created");
        await write(node.children ?? [], folder);
      } else skip();
    }
    await flush();
  };
  for (const [nodes, id] of [
    [toolbar, roots.bar],
    [other, roots.other],
  ] as const) {
    if (!nodes.length) continue;
    const parent = browserRead.getState().bookmarks.nodes[id];
    const empty = parent?.kind === "folder" && !parent.children.length;
    await write(nodes, empty ? id : await addBookmarkFolder({ spaceId, title: `Imported from ${browserName}`, parentId: id }));
  }
  return count;
}

export const importSafariBookmarks = (spaceId: string, root: BookmarkNode | undefined) => importBookmarks(spaceId, root, "Safari");

export async function importArcSpace(spaceId: string, space: SpaceSuggestion): Promise<number> {
  const data = { pinned: space.pinned, tabs: space.tabs.map(draftTab) };
  const command: ImportCommand = { method: "importArcSpace", spaceId, space: data };
  if (fits(command)) return (await dispatchBrowserCommand(command)).count;
  const { tabs, folders } = planArcSpace(data);
  const ids = await openTabs(spaceId, tabs);
  for (const batch of batches(ids)) await pinRows(batch, true);
  const windowId = ids.length ? browserRead.getState().tabs[ids[0]!]!.windowId : await windowFor(spaceId);
  const folderIds: string[] = [];
  for (const folder of folders) {
    const tabIds = ids.slice(folder.start, folder.end);
    folderIds.push(
      await newPinnedFolder(windowId, {
        tabIds: tabIds.slice(0, 1000),
        name: folder.name,
        parentId: folder.parent === undefined ? undefined : folderIds[folder.parent],
        spaceId,
        beforeId: tabIds.length ? undefined : ids.slice(folder.end)[0],
      }),
    );
    for (const batch of batches(tabIds.slice(1000)))
      await placeTabs(batch, { pinned: false, row: true, folderId: folderIds[folderIds.length - 1], beforeId: null });
  }
  return (
    ids.length +
    (await importTabs(
      spaceId,
      space.tabs.map((t) => ({ ...t, pinned: false })),
      "Imported",
    ))
  );
}

export async function importDiaProfile(spaceId: string, profile: DiaTabsProfile, what: { pinned: boolean; open: boolean }): Promise<number> {
  const data = { pinned: profile.pinned.map(draftTab), tabs: profile.tabs.map(draftTab) };
  const command: ImportCommand = { method: "importDiaProfile", spaceId, profile: data, what };
  if (fits(command)) return (await dispatchBrowserCommand(command)).count;
  const have = new Set(
    Object.values(browserRead.getState().tabs)
      .filter((t) => t.spaceId === spaceId)
      .flatMap((t) => [t.url, t.pinnedUrl ?? ""].filter(Boolean).map(pageKey)),
  );
  const fresh = (tabs: TabDraft[]) => tabs.filter((t) => !have.has(pageKey(t.url)));
  let count = what.pinned ? await importTabs(spaceId, fresh(data.pinned), null) : 0;
  if (what.open)
    count += await importTabs(
      spaceId,
      fresh(data.tabs).map((t) => ({ ...t, pinned: false })),
      "Imported",
    );
  return count;
}

export async function openInWebStore(spaceId: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const windowId = await windowFor(spaceId);
  for (const [i, url] of urls.entries()) await newTab(windowId, { url, spaceId, background: i > 0 });
}
