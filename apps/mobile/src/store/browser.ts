import { create } from "zustand";

import { t } from "@/i18n";

import { bookmarkDrafts, draftLinkCount } from "@/import/apply";
import type { ExportContents } from "@/import/exports";

import { BOOKMARKS_ROOT, bookmarkChildren, bookmarkLinks, bookmarkRoom, draftNodes } from "./bookmarks";
import {
  createTab,
  HISTORY_LIMIT,
  initialBrowserData,
  reduceBrowserData,
  SPACE_COLORS,
  spaceBookmarks,
  spaceHistory,
  unusedSpaceIcon,
  type BrowserAction,
} from "./model";
import type { BrowserData, SpaceColor } from "./types";

// The store is the state in memory. Reading it from disk, saving it and pruning what it no longer shows belong to the
// persistence service (`./persistence.ts`), which reaches the store through the BrowserState port.

export const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface BrowserStore {
  ready: boolean;
  data: BrowserData;
  dispatch(action: BrowserAction): void;
  /**
   * Takes the saved state, archiving the tabs left alone too long, and marks the store ready. With nothing saved, the
   * state it started with stays.
   */
  restore(saved: BrowserData | null): void;
  openTab(url: string, background?: boolean, isPrivate?: boolean): string;
  /** Opens imported links as background tabs, or files them in the archive; returns how many were added. */
  importTabs(tabs: readonly { url: string; title: string }[], target: "tabs" | "archive"): number;
  /**
   * Adds what an export held to the space showing: its bookmarks in a folder named for the browser, its favorites to the
   * space's Essentials, its history to the space's. Returns how many of each were added; what Bay had already isn't counted again.
   */
  importExport(contents: ExportContents, choice: ImportChoice, folderName: string): ImportCounts;
  closeTab(id: string): void;
  restoreTab(id: string): string;
  /** Forget every tab, page and pin; the preferences stay. */
  reset(): void;
  /** Switches to a space; the tab it was last sitting on (or a fresh one) becomes current. */
  selectSpace(id: string): void;
  createSpace(): void;
  renameSpace(id: string, name: string): void;
  setSpaceIcon(id: string, icon: string | null): void;
  setSpaceColor(id: string, color: SpaceColor): void;
  /** Moves a space one place along the bar: -1 towards the start, 1 towards the end. */
  moveSpace(id: string, by: -1 | 1): void;
  deleteSpace(id: string): void;
  moveTab(id: string, spaceId: string, folderId: string | null): void;
  newFolder(name: string): void;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
}

/** Which parts of an export to import. */
export interface ImportChoice {
  bookmarks: boolean;
  favorites: boolean;
  history: boolean;
}

/** How much of each part an import added. */
export interface ImportCounts {
  bookmarks: number;
  favorites: number;
  history: number;
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  ready: false,
  data: initialBrowserData(createTab(newId(), Date.now())),
  dispatch(action) {
    set((state) => {
      const data = reduceBrowserData(state.data, action);

      return data === state.data ? state : { data };
    });
  },
  restore(saved) {
    set(saved ? { data: reduceBrowserData(saved, { type: "archive-stale", now: Date.now() }), ready: true } : { ready: true });
  },
  openTab(url, background = false, isPrivate = false) {
    const tab = createTab(newId(), Date.now(), url, isPrivate, get().data.activeSpaceId);
    get().dispatch({ type: "new-tab", tab, background });

    return tab.id;
  },
  importTabs(tabs, target) {
    const now = Date.now();
    const before = get().data;
    const count = target === "tabs" ? before.tabs.length : before.archive.length;
    const created = tabs.map((entry) => ({ ...createTab(newId(), now, entry.url, false, before.activeSpaceId), title: entry.title }));

    get().dispatch(target === "tabs" ? { type: "import-tabs", tabs: created } : { type: "import-archive", tabs: created, now });
    const after = get().data;

    return (target === "tabs" ? after.tabs.length : after.archive.length) - count;
  },
  importExport(contents, choice, folderName) {
    const now = Date.now();
    const before = get().data;
    const spaceId = before.activeSpaceId;
    const tree = spaceBookmarks(before, spaceId);
    const counts: ImportCounts = { bookmarks: 0, favorites: 0, history: 0 };

    if (choice.bookmarks) {
      const drafts = bookmarkDrafts(contents.bookmarks, tree);

      if (drafts.length) {
        // A second import from the same browser joins the folder the first one made.
        const folder = bookmarkChildren(tree, BOOKMARKS_ROOT).find((node) => node.kind === "folder" && node.title === folderName);

        const nodes = folder
          ? draftNodes(drafts, folder.id, newId, now, bookmarkRoom(tree))
          : draftNodes([{ title: folderName, children: drafts, addedAt: now }], BOOKMARKS_ROOT, newId, now, bookmarkRoom(tree));

        get().dispatch({ type: "add-bookmarks", spaceId, nodes });
        counts.bookmarks = Math.min(draftLinkCount(drafts), bookmarkLinks(spaceBookmarks(get().data, spaceId)).length - bookmarkLinks(tree).length);
      }
    }

    if (choice.favorites && contents.favorites.length) {
      const pinned = get().data.pinnedSites.length;
      const sites = contents.favorites.flatMap((favorite) => (favorite.url ? [{ id: newId(), url: favorite.url, title: favorite.title, favicon: null }] : []));

      get().dispatch({ type: "import-pins", sites });
      counts.favorites = get().data.pinnedSites.length - pinned;
    }

    if (choice.history && contents.history.length) {
      // Only the newest pages can stay: Bay keeps so many.
      const entries = contents.history.slice(0, HISTORY_LIMIT).map((visit) => ({ ...visit, spaceId, favicon: null }));
      const urls = new Set(entries.map((entry) => entry.url));

      get().dispatch({ type: "import-history", entries });
      counts.history = spaceHistory(get().data, spaceId).filter((entry) => urls.has(entry.url)).length;
    }

    return counts;
  },
  closeTab(id) {
    const tab = get().data.tabs.find((entry) => entry.id === id);

    get().dispatch({ type: "close-tab", id, now: Date.now(), fallback: createTab(newId(), Date.now(), "", false, tab?.spaceId) });
  },
  restoreTab(id) {
    const restoredId = newId();
    get().dispatch({ type: "restore-tab", id, restoredId, now: Date.now() });

    return restoredId;
  },
  reset() {
    set((state) => ({ data: initialBrowserData(createTab(newId(), Date.now()), { ...state.data.preferences, hiddenElements: {} }) }));
  },
  selectSpace(id) {
    const data = get().data;
    const hasTab = data.tabs.some((tab) => tab.spaceId === id);

    if (hasTab) {
      get().dispatch({ type: "select-space", id });
    } else {
      get().dispatch({ type: "select-space", id, blankTab: createTab(newId(), Date.now(), "", false, id) });
    }
  },
  createSpace() {
    const data = get().data;
    const index = data.spaces.length + 1;

    const space = {
      id: newId(),
      name: t("space.default", { index }),
      color: SPACE_COLORS[(index - 1) % SPACE_COLORS.length]!,
      icon: unusedSpaceIcon(data.spaces),
    };

    get().dispatch({ type: "create-space", space, blankTab: createTab(newId(), Date.now(), "", false, space.id) });
  },
  renameSpace(id, name) {
    get().dispatch({ type: "rename-space", id, name });
  },
  setSpaceIcon(id, icon) {
    get().dispatch({ type: "set-space-icon", id, icon });
  },
  setSpaceColor(id, color) {
    get().dispatch({ type: "set-space-color", id, color });
  },
  moveSpace(id, by) {
    const index = get().data.spaces.findIndex((space) => space.id === id);

    if (index >= 0) get().dispatch({ type: "reorder-space", id, to: index + by });
  },
  deleteSpace(id) {
    get().dispatch({ type: "delete-space", id, blankTab: createTab(newId(), Date.now()) });
  },
  moveTab(id, spaceId, folderId) {
    get().dispatch({ type: "move-tab", id, spaceId, folderId });
  },
  newFolder(name) {
    const data = get().data;

    get().dispatch({ type: "new-folder", folder: { id: newId(), spaceId: data.activeSpaceId, name } });
  },
  renameFolder(id, name) {
    get().dispatch({ type: "rename-folder", id, name });
  },
  deleteFolder(id) {
    get().dispatch({ type: "delete-folder", id });
  },
}));
