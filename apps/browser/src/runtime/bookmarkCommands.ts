import type { BrowserState, BrowserStore } from "../store/browser";
import type { BookmarkDraft } from "../store/bookmarks";
import { isIncognitoSpace } from "../store/model";
import {
  commandFields,
  commandIds,
  commandIndex,
  commandObject,
  commandText,
  commandTimestamp,
  commandUrl,
  invalidCommand,
  requireCommandSpace,
  type CommandReaders,
} from "./commandValidation";

type Place = { parentId?: string; index?: number };
export type UserBookmarkOptions = { spaceId: string; url: string; title: string; favicon?: string | null } & Place;
export type UserBookmarkFolderOptions = { spaceId: string; title: string } & Place;
export type BookmarkPatch = { title?: string; url?: string; favicon?: string | null };
export type BookmarkPage = { url: string; title: string; favicon: string | null };
export type BookmarkCommand =
  | { method: "addBookmark"; options: UserBookmarkOptions }
  | { method: "addBookmarkFolder"; options: UserBookmarkFolderOptions }
  | { method: "addBookmarkTree"; spaceId: string; drafts: BookmarkDraft[]; parentId?: string; index?: number }
  | { method: "updateBookmark"; bookmarkId: string; patch: BookmarkPatch }
  | { method: "moveBookmark"; bookmarkId: string; parentId: string; index?: number }
  | { method: "removeBookmark"; bookmarkId: string }
  | { method: "toggleBookmark"; spaceId: string; page: BookmarkPage }
  | { method: "removeBookmarks"; spaceId: string; bookmarkIds: string[] }
  | { method: "restoreBookmarks"; undoId: string };

export const BOOKMARK_COMMAND_METHODS = [
  "addBookmark",
  "addBookmarkFolder",
  "addBookmarkTree",
  "updateBookmark",
  "moveBookmark",
  "removeBookmark",
  "toggleBookmark",
  "removeBookmarks",
  "restoreBookmarks",
] as const;

const MAX_DRAFTS = 10_000;
const MAX_DRAFT_DEPTH = 16;
const title = (value: unknown) => commandText(value, 1024 * 16, true);
const favicon = (value: unknown) => (value === null ? null : commandUrl(value));
const place: CommandReaders<Place> = { parentId: commandText, index: commandIndex };

function drafts(value: unknown): BookmarkDraft[] {
  let count = 0;
  const read = (list: unknown, depth: number): BookmarkDraft[] => {
    if (!Array.isArray(list) || depth > MAX_DRAFT_DEPTH) return invalidCommand("invalid bookmark drafts");
    return Array.from(list, (item) => {
      if (++count > MAX_DRAFTS) return invalidCommand("too many bookmark drafts");
      const d = commandObject(item, ["title", "url", "addedAt", "children"]);
      if (d.url !== undefined && d.children !== undefined) return invalidCommand("a bookmark draft is a page or a folder");
      return {
        title: title(d.title),
        ...(d.url !== undefined ? { url: commandUrl(d.url) } : {}),
        ...(d.addedAt !== undefined ? { addedAt: commandTimestamp(d.addedAt) } : {}),
        ...(d.children !== undefined ? { children: read(d.children, depth + 1) } : {}),
      };
    });
  };
  return read(value, 1);
}

export function parseBookmarkCommand(value: unknown): BookmarkCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const bookmarkId = () => commandText(c.bookmarkId);
  const spaceId = () => commandText(c.spaceId);
  switch (c.method) {
    case "addBookmark": {
      fields("options");
      const o = commandObject(c.options, ["spaceId", "url", "title", "favicon", "parentId", "index"]);
      return {
        method: c.method,
        options: { spaceId: commandText(o.spaceId), url: commandUrl(o.url), title: title(o.title), ...commandFields(o, { favicon, ...place }) },
      };
    }
    case "addBookmarkFolder": {
      fields("options");
      const o = commandObject(c.options, ["spaceId", "title", "parentId", "index"]);
      return { method: c.method, options: { spaceId: commandText(o.spaceId), title: title(o.title), ...commandFields(o, place) } };
    }
    case "addBookmarkTree":
      fields("spaceId", "drafts", "parentId", "index");
      return { method: c.method, spaceId: spaceId(), drafts: drafts(c.drafts), ...commandFields(c, place) };
    case "updateBookmark": {
      fields("bookmarkId", "patch");
      const p = commandObject(c.patch, ["title", "url", "favicon"]);
      return { method: c.method, bookmarkId: bookmarkId(), patch: commandFields<BookmarkPatch>(p, { title, url: commandUrl, favicon }) };
    }
    case "moveBookmark":
      fields("bookmarkId", "parentId", "index");
      return {
        method: c.method,
        bookmarkId: bookmarkId(),
        parentId: commandText(c.parentId),
        ...(c.index !== undefined ? { index: commandIndex(c.index) } : {}),
      };
    case "removeBookmark":
      fields("bookmarkId");
      return { method: c.method, bookmarkId: bookmarkId() };
    case "toggleBookmark": {
      fields("spaceId", "page");
      const p = commandObject(c.page, ["url", "title", "favicon"]);
      return { method: c.method, spaceId: spaceId(), page: { url: commandUrl(p.url), title: title(p.title), favicon: favicon(p.favicon ?? null) } };
    }
    case "removeBookmarks":
      fields("spaceId", "bookmarkIds");
      return { method: c.method, spaceId: spaceId(), bookmarkIds: commandIds(c.bookmarkIds) };
    case "restoreBookmarks":
      fields("undoId");
      return { method: c.method, undoId: commandText(c.undoId) };
    default:
      return invalidCommand("unknown bookmark command");
  }
}

// A tree is named by its bar folder: spaces sharing a profile share one. A space has none until its first bookmark.
function spaceTree(s: BrowserState, spaceId: string): string | undefined {
  requireCommandSpace(s, spaceId);
  return s.bookmarks.roots[spaceId]?.bar;
}
function topFolderOf(s: BrowserState, id: string): string | undefined {
  let node = s.bookmarks.nodes[id];
  for (let i = 0; node?.parentId && i < 64; i++) node = s.bookmarks.nodes[node.parentId];
  return node && node.parentId === null ? node.id : undefined;
}
/** A bookmark below a public space's top folders, and its tree; a top folder itself only when `top` allows it. */
function requireBookmark(s: BrowserState, id: string, top = false) {
  const node = Object.hasOwn(s.bookmarks.nodes, id) ? s.bookmarks.nodes[id] : undefined;
  const root = topFolderOf(s, id);
  const roots = Object.entries(s.bookmarks.roots).find(
    ([spaceId, r]) => !isIncognitoSpace(spaceId) && Object.hasOwn(s.spaces, spaceId) && (r.bar === root || r.other === root),
  )?.[1];
  if (!node || !roots || (!top && node.parentId === null)) return invalidCommand("bookmark no longer exists");
  return { node, tree: roots.bar };
}
function requireFolderIn(s: BrowserState, id: string, tree: string | undefined) {
  const folder = requireBookmark(s, id, true);
  if (folder.node.kind !== "folder" || folder.tree !== tree) return invalidCommand("folder is not in this space's bookmarks");
}

export function executeBookmarkCommand(store: BrowserStore, command: BookmarkCommand): string | null {
  const s = store.getState();
  switch (command.method) {
    case "addBookmark":
    case "addBookmarkFolder": {
      const { spaceId, parentId } = command.options;
      const tree = spaceTree(s, spaceId);
      if (parentId) requireFolderIn(s, parentId, tree);
      return command.method === "addBookmark" ? s.addBookmark(command.options) : s.addBookmarkFolder(command.options);
    }
    case "addBookmarkTree": {
      const tree = spaceTree(s, command.spaceId);
      if (command.parentId) requireFolderIn(s, command.parentId, tree);
      s.addBookmarkTree(command.spaceId, command.drafts, command.parentId, command.index);
      break;
    }
    case "updateBookmark":
      requireBookmark(s, command.bookmarkId);
      s.updateBookmark(command.bookmarkId, command.patch);
      break;
    case "moveBookmark": {
      const { tree } = requireBookmark(s, command.bookmarkId);
      requireFolderIn(s, command.parentId, tree);
      s.moveBookmark(command.bookmarkId, command.parentId, command.index);
      break;
    }
    case "removeBookmark":
      requireBookmark(s, command.bookmarkId);
      s.removeBookmark(command.bookmarkId);
      break;
    case "toggleBookmark":
      requireCommandSpace(s, command.spaceId);
      s.toggleBookmark(command.spaceId, command.page);
      break;
    case "removeBookmarks": {
      const tree = spaceTree(s, command.spaceId);
      for (const id of command.bookmarkIds) if (requireBookmark(s, id).tree !== tree) return invalidCommand("bookmark is not in this space's bookmarks");
      return s.removeBookmarksWithUndo(command.spaceId, command.bookmarkIds) || null;
    }
    case "restoreBookmarks":
      if (!s.bookmarkUndo.some((u) => u.id === command.undoId)) return invalidCommand("nothing to restore");
      s.restoreRemovedBookmarks(command.undoId);
      break;
  }
  return null;
}
