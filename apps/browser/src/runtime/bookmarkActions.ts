import type { BookmarkDraft } from "../store/bookmarks";
import { dispatchBrowserCommand } from "./commands";
import type { BookmarkPage, BookmarkPatch, UserBookmarkFolderOptions, UserBookmarkOptions } from "./bookmarkCommands";

export const addBookmark = (options: UserBookmarkOptions) => dispatchBrowserCommand({ method: "addBookmark", options });
export const addBookmarkFolder = (options: UserBookmarkFolderOptions) => dispatchBrowserCommand({ method: "addBookmarkFolder", options });
export const addBookmarkTree = (spaceId: string, drafts: BookmarkDraft[], parentId?: string) =>
  dispatchBrowserCommand({ method: "addBookmarkTree", spaceId, drafts, parentId });
export const updateBookmark = (bookmarkId: string, patch: BookmarkPatch) => dispatchBrowserCommand({ method: "updateBookmark", bookmarkId, patch });
export const moveBookmark = (bookmarkId: string, parentId: string, index?: number) =>
  dispatchBrowserCommand({ method: "moveBookmark", bookmarkId, parentId, index });
export const removeBookmark = (bookmarkId: string) => dispatchBrowserCommand({ method: "removeBookmark", bookmarkId });
// Only the page's address, title and favicon cross; a tab carries much more.
export const toggleBookmark = (spaceId: string, { url, title, favicon }: BookmarkPage) =>
  dispatchBrowserCommand({ method: "toggleBookmark", spaceId, page: { url, title, favicon } });
export const removeBookmarks = (spaceId: string, bookmarkIds: string[]) => dispatchBrowserCommand({ method: "removeBookmarks", spaceId, bookmarkIds });
export const restoreBookmarks = (undoId: string) => dispatchBrowserCommand({ method: "restoreBookmarks", undoId });

export const removeHistory = (spaceId: string, urls: string[]) => dispatchBrowserCommand({ method: "removeHistory", spaceId, urls });
export const clearHistory = (spaceId: string, since?: number) => dispatchBrowserCommand({ method: "clearHistory", spaceId, since });
