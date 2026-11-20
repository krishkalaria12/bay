import { create } from "zustand";

import { t } from "@/i18n";

import { createTab, initialBrowserData, reduceBrowserData, SPACE_COLORS, type BrowserAction } from "./model";
import type { BrowserData } from "./types";

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
  closeTab(id: string): void;
  restoreTab(id: string): string;
  /** Forget every tab, page and pin; the preferences stay. */
  reset(): void;
  /** Switches to a space; the tab it was last sitting on (or a fresh one) becomes current. */
  selectSpace(id: string): void;
  createSpace(): void;
  renameSpace(id: string, name: string): void;
  deleteSpace(id: string): void;
  moveTab(id: string, spaceId: string, folderId: string | null): void;
  newFolder(name: string): void;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
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
    const space = { id: newId(), name: t("space.default", { index }), color: SPACE_COLORS[(index - 1) % SPACE_COLORS.length]! };

    get().dispatch({ type: "create-space", space, blankTab: createTab(newId(), Date.now(), "", false, space.id) });
  },
  renameSpace(id, name) {
    get().dispatch({ type: "rename-space", id, name });
  },
  deleteSpace(id) {
    get().dispatch({ type: "delete-space", id });
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
