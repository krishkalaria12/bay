/**
 * Bookmarks: one tree of folders and links, kept in the browsing state beside the pins. Most arrive from another
 * browser's export (src/import); a page can also be bookmarked from its menu. Pure, so the reducer and Node's tests
 * share it.
 */
import * as v from "valibot";
import type { BookmarkFolder, BookmarkNode, Bookmarks, JsonValue } from "./types.ts";

/** The folder every bookmark hangs off. It has no title of its own and is never removed. */
export const BOOKMARKS_ROOT = "bookmarks";

/** How many bookmarks and folders Bay keeps: enough for years of bookmarking, small enough to save quickly. */
export const BOOKMARK_LIMIT = 5000;

const TITLE_LIMIT = 300;

/** A bookmark or folder that doesn't have an id yet: what an import builds. */
export interface BookmarkDraft {
  title: string;
  /** Absent on a folder. */
  url?: string;
  addedAt?: number;
  children?: BookmarkDraft[];
}

export const emptyBookmarks = (): Bookmarks => ({
  [BOOKMARKS_ROOT]: { kind: "folder", id: BOOKMARKS_ROOT, parentId: null, title: "", children: [], addedAt: 0 },
});

/** A folder by id, or null when there is none (or the id is a link's). */
export function bookmarkFolder(bookmarks: Bookmarks, id: string): BookmarkFolder | null {
  const node = bookmarks[id];

  return node?.kind === "folder" ? node : null;
}

/** A folder's children, in order. */
export function bookmarkChildren(bookmarks: Bookmarks, folderId: string): BookmarkNode[] {
  return (bookmarkFolder(bookmarks, folderId)?.children ?? []).flatMap((id) => {
    const node = bookmarks[id];

    return node ? [node] : [];
  });
}

/** Every link in the tree, in the order a walk from the root meets them. */
export function bookmarkLinks(bookmarks: Bookmarks, folderId = BOOKMARKS_ROOT): Extract<BookmarkNode, { kind: "url" }>[] {
  return bookmarkChildren(bookmarks, folderId).flatMap((node) => (node.kind === "url" ? [node] : bookmarkLinks(bookmarks, node.id)));
}

/** How many links a folder holds, however deep. */
export const folderLinkCount = (bookmarks: Bookmarks, folderId: string): number => bookmarkLinks(bookmarks, folderId).length;

/** The folders from the root down to a folder, the root left out. */
export function bookmarkPath(bookmarks: Bookmarks, folderId: string): BookmarkFolder[] {
  const path: BookmarkFolder[] = [];
  let folder = bookmarkFolder(bookmarks, folderId);

  while (folder && folder.id !== BOOKMARKS_ROOT && path.length < BOOKMARK_LIMIT) {
    path.unshift(folder);
    folder = folder.parentId ? bookmarkFolder(bookmarks, folder.parentId) : null;
  }

  return path;
}

/** Whether a page is bookmarked anywhere in the tree. */
export const isBookmarked = (bookmarks: Bookmarks, url: string): boolean => Object.values(bookmarks).some((node) => node.kind === "url" && node.url === url);

/** How many more nodes the tree has room for. */
export const bookmarkRoom = (bookmarks: Bookmarks): number => Math.max(0, BOOKMARK_LIMIT - Object.keys(bookmarks).length);

/**
 * Gives drafts ids under a folder, as nodes the reducer adds whole. Takes at most `room` nodes, in order: a folder
 * that doesn't fit leaves out its children too.
 */
export function draftNodes(drafts: readonly BookmarkDraft[], parentId: string, newId: () => string, now: number, room: number): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];

  const add = (draft: BookmarkDraft, parent: string): string | null => {
    if (nodes.length >= room) return null;
    const id = newId();
    const title = draft.title.slice(0, TITLE_LIMIT);
    const addedAt = draft.addedAt ?? now;

    if (draft.url !== undefined) {
      nodes.push({ kind: "url", id, parentId: parent, title, url: draft.url, addedAt });

      return id;
    }

    const folder: BookmarkNode = { kind: "folder", id, parentId: parent, title, children: [], addedAt };
    nodes.push(folder);

    for (const child of draft.children ?? []) {
      const childId = add(child, id);

      if (childId) folder.children.push(childId);
    }

    return id;
  };

  for (const draft of drafts) add(draft, parentId);

  return nodes;
}

/**
 * Adds nodes made by `draftNodes`. Each node whose parent is already in the tree joins the end of that folder; the
 * rest are already listed by their new parents. Nothing is added past the limit, and an id already taken is skipped.
 */
export function addBookmarks(bookmarks: Bookmarks, nodes: readonly BookmarkNode[]): Bookmarks {
  const fresh = nodes.filter((node) => !bookmarks[node.id]).slice(0, bookmarkRoom(bookmarks));

  if (!fresh.length) return bookmarks;
  const next: Bookmarks = { ...bookmarks };
  const batch = new Set(fresh.map((node) => node.id));

  for (const node of fresh) {
    const parent = node.parentId && !batch.has(node.parentId) ? bookmarkFolder(next, node.parentId) : null;

    // A node whose parent is neither in the tree nor in the batch would hang off nothing.
    if (!parent && !(node.parentId && batch.has(node.parentId))) continue;
    next[node.id] = node.kind === "folder" ? { ...node, children: node.children.filter((id) => batch.has(id)) } : node;

    if (parent) next[parent.id] = { ...parent, children: [...(bookmarkFolder(next, parent.id)?.children ?? []), node.id] };
  }

  return next;
}

/** Removes a bookmark, or a folder with everything in it. The root stays. */
export function removeBookmark(bookmarks: Bookmarks, id: string): Bookmarks {
  const node = bookmarks[id];

  if (!node || id === BOOKMARKS_ROOT) return bookmarks;
  const next: Bookmarks = { ...bookmarks };

  const drop = (target: string) => {
    const entry = next[target];

    if (!entry) return;
    delete next[target];

    if (entry.kind === "folder") for (const child of entry.children) drop(child);
  };

  drop(id);
  const parent = node.parentId ? bookmarkFolder(next, node.parentId) : null;

  if (parent) next[parent.id] = { ...parent, children: parent.children.filter((child) => child !== id) };

  return next;
}

/** Removes every bookmark of a page. */
export function removeBookmarksOf(bookmarks: Bookmarks, url: string): Bookmarks {
  return Object.values(bookmarks)
    .filter((node) => node.kind === "url" && node.url === url)
    .reduce((tree, node) => removeBookmark(tree, node.id), bookmarks);
}

const isWebAddress = (value: string): boolean => {
  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
};

const timestamp = v.pipe(v.number(), v.finite(), v.minValue(0));

const savedNode = v.variant("kind", [
  v.object({ kind: v.literal("url"), id: v.string(), title: v.string(), url: v.pipe(v.string(), v.check(isWebAddress)), addedAt: timestamp }),
  v.object({ kind: v.literal("folder"), id: v.string(), title: v.string(), children: v.array(v.string()), addedAt: timestamp }),
]);

const savedTree = v.record(v.string(), v.fallback(v.nullable(savedNode), null));

/**
 * Reads saved bookmarks, repairing the tree: only what a walk from the root reaches is kept (each node once, under
 * the folder that lists it first), up to the limit. A document saved before bookmarks existed has none.
 */
export function parseBookmarks(value: JsonValue | undefined): Bookmarks {
  const parsed = v.safeParse(savedTree, value ?? {});
  const saved = parsed.success ? parsed.output : {};
  const bookmarks = emptyBookmarks();
  const root = saved[BOOKMARKS_ROOT];
  const queue: { id: string; parentId: string }[] = (root?.kind === "folder" ? root.children : []).map((id) => ({ id, parentId: BOOKMARKS_ROOT }));
  let count = 1;

  // Breadth first, so a cut at the limit keeps the top of every folder rather than the depths of the first.
  for (let index = 0; index < queue.length && count < BOOKMARK_LIMIT; index++) {
    const { id, parentId } = queue[index]!;
    const node = saved[id];
    const parent = bookmarkFolder(bookmarks, parentId);

    if (!node || node.id !== id || bookmarks[id] || !parent) continue;
    count += 1;
    parent.children.push(id);
    const title = node.title.slice(0, TITLE_LIMIT);

    if (node.kind === "url") {
      bookmarks[id] = { kind: "url", id, parentId, title, url: node.url, addedAt: node.addedAt };
      continue;
    }

    bookmarks[id] = { kind: "folder", id, parentId, title, children: [], addedAt: node.addedAt };
    queue.push(...node.children.map((child) => ({ id: child, parentId: id })));
  }

  return bookmarks;
}
