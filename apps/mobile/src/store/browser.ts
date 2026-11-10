import { pruneSnapshots, pruneTabStates } from "@bay/engine";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { create } from "zustand";

import { createTab, initialBrowserData, parseBrowserData, persistedBrowserData, reduceBrowserData, SPACE_COLORS, type BrowserAction } from "./model";
import type { BrowserData, BrowserRepository } from "./types";

const SAVE_DELAY = 400;
const PRUNE_DELAY = 5000;

// One versioned JSON document: the tab model matches desktop's, so sync can map it as a whole. Writes go to a
// temporary file first and replace the saved one in a single move, so a crash never leaves half a file.
const STATE_FILE = "browser.json";

const repository: BrowserRepository = {
  async load() {
    const file = new File(Paths.document, STATE_FILE);

    return file.exists ? JSON.parse(await file.text()) : null;
  },
  async save(data) {
    const draft = new File(Paths.document, `${STATE_FILE}.tmp`);
    await draft.write(JSON.stringify({ version: 2, ...persistedBrowserData(data) }));
    await draft.move(new File(Paths.document, STATE_FILE), { overwrite: true });
  },
};

export const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface BrowserStore {
  ready: boolean;
  data: BrowserData;
  dispatch(action: BrowserAction): void;
  load(): Promise<void>;
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
  async load() {
    const fallback = get().data;

    try {
      const saved = await repository.load();
      const data = saved === null ? fallback : parseBrowserData(saved, fallback);
      set({ data: reduceBrowserData(data, { type: "archive-stale", now: Date.now() }), ready: true });
    } catch (error) {
      console.warn("Couldn't read saved browsing state; starting fresh.", error);
      set({ ready: true });
    }
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
    const space = { id: newId(), name: `Space ${index}`, color: SPACE_COLORS[(index - 1) % SPACE_COLORS.length]! };

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

let saveTimer: ReturnType<typeof setTimeout> | undefined;

// One save at a time: two writing the same temporary file at once lose one of them.
let saving: Promise<void> = Promise.resolve();

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;

  if (!useBrowserStore.getState().ready) return;
  saving = saving.then(() => repository.save(useBrowserStore.getState().data)).catch((cause: unknown) => console.warn("Couldn't save browsing state.", cause));
}

useBrowserStore.subscribe((state, previous) => {
  if (state.data === previous.data || !state.ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
});

// Page views delete only their own previous snapshot, so closed, archived and remounted tabs leave files behind;
// keep just the ones a tab or archived tab still shows.
let pruneTimer: ReturnType<typeof setTimeout> | undefined;

useBrowserStore.subscribe((state, previous) => {
  if (!state.ready || (previous.ready && state.data.tabs === previous.data.tabs && state.data.archive === previous.data.archive)) return;
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => {
    const { tabs, archive } = useBrowserStore.getState().data;
    const keep = [...tabs, ...archive].flatMap((tab) => (tab.snapshot ? [tab.snapshot] : []));
    pruneSnapshots(keep).catch((cause: unknown) => console.warn("Couldn't prune tab snapshots.", cause));
    // Saved page state is only worth keeping for open, non-private tabs; archived tabs reopen with their address.
    pruneTabStates(tabs.filter((tab) => !tab.private).map((tab) => tab.id)).catch((cause: unknown) => console.warn("Couldn't prune saved tab states.", cause));
  }, PRUNE_DELAY);
});

AppState.addEventListener("change", (status) => {
  if (status === "active") {
    if (useBrowserStore.getState().ready) useBrowserStore.getState().dispatch({ type: "archive-stale", now: Date.now() });
  } else {
    // Saved straight away: Bay may be killed in the background, and the start page timer needs this on next launch.
    if (status === "background" && useBrowserStore.getState().ready) useBrowserStore.getState().dispatch({ type: "left", now: Date.now() });

    if (saveTimer) save();
  }
});
