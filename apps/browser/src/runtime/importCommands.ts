import type { BookmarkNode as ImportedNode, ImportedTab } from "@bay/import";
import type { BookmarkDraft } from "../store/bookmarks";
import type { BrowserStore } from "../store/browser";
import type { BrowserProjection } from "./projection";
import { listIds, tabListKey } from "../store/model";
import { withNewTab } from "../store/tabs";
import { executeBookmarkCommand } from "./bookmarkCommands";
import {
  commandBoolean,
  commandObject,
  commandText,
  commandTimestamp,
  commandUrl,
  invalidCommand,
  requireCommandSpace,
  requireCommandTab,
} from "./commandValidation";

const toDraft = (n: ImportedNode): BookmarkDraft =>
  n.type === "url"
    ? { title: n.title || n.url || "", url: n.url ?? "", addedAt: n.dateAdded }
    : { title: n.title, addedAt: n.dateAdded, children: (n.children ?? []).map(toDraft) };

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

/** An export's top level: its toolbar's contents go to the bar, the rest (its "other" folder opened up) to Other. */
export function splitImportedRoots(children: ImportedNode[]): { toolbar: ImportedNode[]; other: ImportedNode[] } {
  const toolbar = children.filter((c) => c.role === "toolbar").flatMap((c) => c.children ?? []);
  const other = children
    .filter((c) => c.role !== "toolbar")
    .flatMap((c) => (c.type === "folder" && (c.role === "other" || !c.role) ? (c.children ?? []) : [c]));
  return { toolbar, other };
}

function importBookmarks(store: BrowserStore, spaceId: string, root: ImportedNode | undefined, browserName: string): number {
  if (!root?.children?.length) return 0;
  if (!store.getState().bookmarks.roots[spaceId]) store.getState().addBookmarkTree(spaceId, []);
  const roots = store.getState().bookmarks.roots[spaceId]!;
  const { toolbar, other } = splitImportedRoots(root.children);
  const title = `Imported from ${browserName}`;
  const place = (nodes: ImportedNode[], parentId: string) => {
    if (!nodes.length) return;
    const parent = store.getState().bookmarks.nodes[parentId];
    const empty = parent?.kind === "folder" && parent.children.length === 0;
    const drafts = nodes.map(toDraft);
    store.getState().addBookmarkTree(spaceId, empty ? drafts : [{ title, children: drafts }], parentId);
  };
  place(toolbar, roots.bar);
  place(other, roots.other);
  return linkCount([...toolbar, ...other]);
}

function importHistory(store: BrowserStore, spaceId: string, entries: ImportHistoryEntry[]): number {
  const before = store.getState().history[spaceId]?.length ?? 0;
  store.getState().importHistory(spaceId, entries);
  return (store.getState().history[spaceId]?.length ?? 0) - before;
}

/** The most recently focused regular (not private, not Little Bay) window, which imported tabs open in. */
export function regularWindowId(s: Pick<BrowserProjection, "ui" | "windows" | "windowOrder">): string | undefined {
  const regular = (id: string) => !!s.windows[id] && !s.windows[id]!.incognito && s.windows[id]!.kind !== "small";
  return s.ui.focusOrder.find(regular) ?? s.windowOrder.find(regular);
}

function windowFor(store: BrowserStore, spaceId: string): string {
  return regularWindowId(store.getState()) ?? store.getState().createWindow({ spaceId });
}

export type TabDraft = Pick<ImportedTab, "url" | "title" | "pinned" | "customTitle">;

export const usable = (t: TabDraft) => /^(https?|file):/.test(t.url);

/** Opens the tabs in the profile's window, unpinned ones in order after each other; the ids line up with `tabs`. */
function openTabs(store: BrowserStore, spaceId: string, tabs: TabDraft[], afterId?: string): (string | null)[] {
  const windowId = windowFor(store, spaceId);
  let s = store.getState();
  let last: string | undefined = afterId;
  const ids = tabs.map((t) => {
    const after = t.pinned ? undefined : last;
    const [next, id] = withNewTab(s, windowId, {
      url: t.url,
      spaceId,
      background: true,
      pinned: t.pinned,
      snapshot: { title: t.title, customTitle: t.customTitle ?? null },
      index: after ? listIds(s, tabListKey(s, s.tabs[after]!)).indexOf(after) + 1 : undefined,
    });
    if (!id) return null;
    s = { ...next, tabs: { ...next.tabs, [id]: { ...next.tabs[id]!, navigation: null } } };
    if (!t.pinned) last = id;
    return id;
  });
  store.setState(s);
  return ids;
}

/** Opens the usable tabs, grouping the unpinned ones under `group`; `requested` counts the tabs asked for. */
function openGrouped(store: BrowserStore, spaceId: string, tabs: TabDraft[], group: string | null, afterId?: string) {
  const fresh = tabs.filter(usable);
  const ids = fresh.length ? openTabs(store, spaceId, fresh, afterId) : [];
  const unpinned = ids.filter((id, i): id is string => !!id && !fresh[i]!.pinned);
  if (group && unpinned.length) store.getState().createGroup(unpinned, { name: group });
  return { requested: fresh.length, ids };
}

const importTabs = (store: BrowserStore, spaceId: string, tabs: TabDraft[], group: string | null): number => openGrouped(store, spaceId, tabs, group).requested;

/** Keeps Arc's pinned order and folder tree, with overflow tabs retained in the fifth folder level. */
function importArcSpace(store: BrowserStore, spaceId: string, space: { pinned: ImportedNode[]; tabs: TabDraft[] }): number {
  const { tabs, folders } = planArcSpace(space);
  const ids = openTabs(store, spaceId, tabs);
  const rows = ids.filter((id): id is string => !!id);
  if (rows.length) store.getState().pinRows(rows, true);
  const windowId = rows.length ? store.getState().tabs[rows[0]!]!.windowId : windowFor(store, spaceId);
  const folderIds: string[] = [];
  for (const folder of folders) {
    const tabIds = ids.slice(folder.start, folder.end).filter((id): id is string => !!id);
    folderIds.push(
      store.getState().newPinnedFolder(windowId, {
        tabIds,
        name: folder.name,
        parentId: folder.parent === undefined ? undefined : folderIds[folder.parent],
        spaceId,
        beforeId: tabIds.length ? undefined : ids.slice(folder.end).find((id): id is string => !!id),
      }),
    );
  }
  return (
    rows.length +
    importTabs(
      store,
      spaceId,
      space.tabs.map((t) => ({ ...t, pinned: false })),
      "Imported",
    )
  );
}

/** A page's address for matching what a space already has open: scheme and host lowercased, trailing `#` dropped. */
export function pageKey(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url.trim());
  if (!m) return url;
  const rest = m[3]!.startsWith("/") ? m[3]! : `/${m[3]}`;
  return `${m[1]!.toLowerCase()}${m[2]!.toLowerCase()}${rest.replace(/#$/, "")}`;
}

function importDiaProfile(
  store: BrowserStore,
  spaceId: string,
  profile: { pinned: TabDraft[]; tabs: TabDraft[] },
  what: { pinned: boolean; open: boolean },
): number {
  const have = new Set(
    Object.values(store.getState().tabs)
      .filter((t) => t.spaceId === spaceId)
      .flatMap((t) => [t.url, t.pinnedUrl ?? ""].filter(Boolean).map(pageKey)),
  );
  const fresh = (tabs: TabDraft[]) => tabs.filter((t) => !have.has(pageKey(t.url)));
  let n = what.pinned ? importTabs(store, spaceId, fresh(profile.pinned), null) : 0;
  if (what.open)
    n += importTabs(
      store,
      spaceId,
      fresh(profile.tabs).map((t) => ({ ...t, pinned: false })),
      "Imported",
    );
  return n;
}

export function planArcSpace(space: { pinned: ImportedNode[]; tabs: TabDraft[] }) {
  const asTab = (n: ImportedNode): TabDraft => ({ url: n.url!, title: n.pageTitle ?? n.title, pinned: false, customTitle: n.pageTitle ? n.title : undefined });
  const tabs: TabDraft[] = [];
  const folders: { name: string; parent: number | undefined; start: number; end: number }[] = [];
  type Visit = { node: ImportedNode; parent: number | undefined; depth: number } | { finish: number };
  const pending: Visit[] = [...space.pinned].reverse().map((node) => ({ node, parent: undefined, depth: 0 }));
  while (pending.length) {
    const entry = pending.pop()!;
    if ("finish" in entry) {
      folders[entry.finish]!.end = tabs.length;
      continue;
    }
    const { node, depth } = entry;
    if (node.type === "url") {
      if (node.url && usable(asTab(node))) tabs.push(asTab(node));
      continue;
    }
    let parent = entry.parent;
    if (depth < 5) {
      parent = folders.push({ name: node.title, parent, start: tabs.length, end: tabs.length }) - 1;
      pending.push({ finish: parent });
    }
    for (const child of [...(node.children ?? [])].reverse()) pending.push({ node: child, parent, depth: Math.min(depth + 1, 5) });
  }
  return { tabs, folders };
}

export type ImportHistoryEntry = { url: string; title: string; visits: number; lastVisit: number };
export type ImportCommand =
  | { method: "importBookmarks"; spaceId: string; root: ImportedNode; browserName: string; parentId?: string }
  | { method: "importHistory"; spaceId: string; entries: ImportHistoryEntry[] }
  | { method: "importTabs"; spaceId: string; tabs: TabDraft[]; group: string | null; afterId?: string }
  | { method: "importArcSpace"; spaceId: string; space: { pinned: ImportedNode[]; tabs: TabDraft[] } }
  | { method: "importDiaProfile"; spaceId: string; profile: { pinned: TabDraft[]; tabs: TabDraft[] }; what: { pinned: boolean; open: boolean } };
export const IMPORT_COMMAND_METHODS = ["importBookmarks", "importHistory", "importTabs", "importArcSpace", "importDiaProfile"] as const;
// Native transport accepts at most 1 MiB. This remains below it with UTF-8 encoding and the request envelope.
export const IMPORT_PAYLOAD_CHARS = 240_000;
const MAX_ITEMS = 10_000;
const title = (v: unknown) => commandText(v, 16_384, true);
function list<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return invalidCommand("too many import items");
  return Array.from(value, read);
}
function readTabs(value: unknown): TabDraft[] {
  return list(value, (value) => {
    const t = commandObject(value, ["url", "title", "pinned", "customTitle"]);
    return {
      url: commandUrl(t.url),
      title: title(t.title),
      pinned: commandBoolean(t.pinned),
      ...(t.customTitle !== undefined ? { customTitle: title(t.customTitle) } : {}),
    };
  });
}
function readTree(value: unknown): ImportedNode {
  let count = 0;
  const read = (value: unknown, depth: number): ImportedNode => {
    if (++count > MAX_ITEMS || depth > 256) return invalidCommand("import tree is too large");
    const n = commandObject(value, ["type", "title", "url", "dateAdded", "children", "role", "pageTitle"]);
    if (n.type !== "folder" && n.type !== "url") return invalidCommand("invalid import node");
    if (n.type === "url" && (n.children !== undefined || n.url === undefined)) return invalidCommand("invalid imported page");
    if (n.role !== undefined && !["toolbar", "other", "mobile", "menu", "readingList"].includes(n.role as string))
      return invalidCommand("invalid bookmark role");
    return {
      type: n.type,
      title: title(n.title),
      ...(n.url !== undefined ? { url: commandUrl(n.url) } : {}),
      ...(n.dateAdded !== undefined ? { dateAdded: commandTimestamp(n.dateAdded) } : {}),
      ...(n.pageTitle !== undefined ? { pageTitle: title(n.pageTitle) } : {}),
      ...(n.role !== undefined ? { role: n.role as ImportedNode["role"] } : {}),
      ...(n.children !== undefined ? { children: list(n.children, (n) => read(n, depth + 1)) } : {}),
    };
  };
  return read(value, 1);
}
export function parseImportCommand(value: unknown): ImportCommand {
  const c = commandObject(value);
  if (JSON.stringify(c).length > IMPORT_PAYLOAD_CHARS) return invalidCommand("import batch is too large");
  const spaceId = commandText(c.spaceId);
  switch (c.method) {
    case "importBookmarks":
      commandObject(c, ["method", "spaceId", "root", "browserName", "parentId"]);
      return {
        method: c.method,
        spaceId,
        root: readTree(c.root),
        browserName: title(c.browserName),
        ...(c.parentId !== undefined ? { parentId: commandText(c.parentId) } : {}),
      };
    case "importHistory":
      commandObject(c, ["method", "spaceId", "entries"]);
      return {
        method: c.method,
        spaceId,
        entries: list(c.entries, (value) => {
          const e = commandObject(value, ["url", "title", "visits", "lastVisit"]);
          return { url: commandUrl(e.url), title: title(e.title), visits: commandTimestamp(e.visits), lastVisit: commandTimestamp(e.lastVisit) };
        }),
      };
    case "importTabs":
      commandObject(c, ["method", "spaceId", "tabs", "group", "afterId"]);
      return {
        method: c.method,
        spaceId,
        tabs: readTabs(c.tabs),
        group: c.group === null ? null : title(c.group),
        ...(c.afterId !== undefined ? { afterId: commandText(c.afterId) } : {}),
      };
    case "importArcSpace": {
      commandObject(c, ["method", "spaceId", "space"]);
      const s = commandObject(c.space, ["pinned", "tabs"]);
      // One root keeps the node budget shared across the entire tree.
      const pinned = readTree({ type: "folder", title: "", children: s.pinned }).children!;
      return { method: c.method, spaceId, space: { pinned, tabs: readTabs(s.tabs) } };
    }
    case "importDiaProfile": {
      commandObject(c, ["method", "spaceId", "profile", "what"]);
      const p = commandObject(c.profile, ["pinned", "tabs"]);
      const w = commandObject(c.what, ["pinned", "open"]);
      return {
        method: c.method,
        spaceId,
        profile: { pinned: readTabs(p.pinned), tabs: readTabs(p.tabs) },
        what: { pinned: commandBoolean(w.pinned), open: commandBoolean(w.open) },
      };
    }
    default:
      return invalidCommand("unknown import command");
  }
}
/** Imported public data is reduced only by the authority. Credentials and native vault tokens never enter these commands. */
export function executeImportCommand(store: BrowserStore, c: ImportCommand): ImportCommandResult {
  requireCommandSpace(store.getState(), c.spaceId);
  switch (c.method) {
    case "importBookmarks": {
      if (!c.parentId) return { count: importBookmarks(store, c.spaceId, c.root, c.browserName) };
      const before = store.getState().bookmarks.nodes[c.parentId];
      const existing = new Set(before?.kind === "folder" ? before.children : []);
      executeBookmarkCommand(store, { method: "addBookmarkTree", spaceId: c.spaceId, drafts: (c.root.children ?? []).map(toDraft), parentId: c.parentId });
      const parent = store.getState().bookmarks.nodes[c.parentId];
      const bookmarkIds = parent?.kind === "folder" ? parent.children.filter((id) => !existing.has(id)) : [];
      return { count: linkCount(c.root.children ?? []), bookmarkIds };
    }
    case "importHistory":
      return { count: importHistory(store, c.spaceId, c.entries) };
    case "importTabs": {
      if (c.afterId) {
        const after = requireCommandTab(store.getState(), c.afterId);
        if (after.spaceId !== c.spaceId || after.pinned || after.pinnedRow) return invalidCommand("import continuation belongs to another list");
      }
      const tabIds = openGrouped(store, c.spaceId, c.tabs, c.group, c.afterId).ids.filter((id): id is string => !!id);
      return { count: tabIds.length, tabIds };
    }
    case "importArcSpace":
      return { count: importArcSpace(store, c.spaceId, c.space) };
    case "importDiaProfile":
      return { count: importDiaProfile(store, c.spaceId, c.profile, c.what) };
  }
}

export type ImportCommandResult = { count: number; tabIds?: string[]; bookmarkIds?: string[] };

// The ids a reply may name, and only for the command that creates them.
const REPLY_IDS: Partial<Record<string, "tabIds" | "bookmarkIds">> = { importTabs: "tabIds", importBookmarks: "bookmarkIds" };

const uniqueIds = (ids: unknown[]) => new Set(ids.map((id) => commandText(id))).size === ids.length;

export function validateImportReply(method: string, value: unknown): value is ImportCommandResult {
  if (!(IMPORT_COMMAND_METHODS as readonly string[]).includes(method)) return false;
  const idsKey = REPLY_IDS[method];
  try {
    const r = commandObject(value, idsKey ? ["count", idsKey] : ["count"]);
    if (typeof r.count !== "number" || !Number.isSafeInteger(r.count) || r.count < 0 || r.count > 20_000) return false;
    if (method === "importBookmarks" && r.bookmarkIds !== undefined)
      return Array.isArray(r.bookmarkIds) && r.bookmarkIds.length <= MAX_ITEMS && uniqueIds(r.bookmarkIds);
    if (method !== "importTabs") return true;
    return Array.isArray(r.tabIds) && r.tabIds.length === r.count && uniqueIds(r.tabIds);
  } catch {
    return false;
  }
}
