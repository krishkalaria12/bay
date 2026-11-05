import { pruneSnapshots } from "@bay/engine";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { create } from "zustand";

import { createTab, initialBrowserData, parseBrowserData, persistedBrowserData, reduceBrowserData, type BrowserAction } from "./model";
import type { BrowserData, BrowserRepository } from "./types";

const SAVE_DELAY = 400;
const PRUNE_DELAY = 5000;

// One versioned JSON document: the tab model matches desktop's, so sync can map it as a whole. Writes go to a
// temporary file first and replace the saved one in a single move, so a crash never leaves half a file.
const STATE_FILE = "browser.json";

const repository: BrowserRepository = {
  async load() {
    const file = new File(Paths.document, STATE_FILE);
    return file.exists ? (JSON.parse(await file.text()) as unknown) : null;
  },
  async save(data) {
    const draft = new File(Paths.document, `${STATE_FILE}.tmp`);
    await draft.write(JSON.stringify({ version: 1, ...persistedBrowserData(data) }));
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
  closeTab(id: string): void;
  restoreTab(id: string): string;
  /** Forget every tab, page and pin; the preferences stay. */
  reset(): void;
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
    const tab = createTab(newId(), Date.now(), url, isPrivate);
    get().dispatch({ type: "new-tab", tab, background });
    return tab.id;
  },
  closeTab(id) {
    get().dispatch({ type: "close-tab", id, now: Date.now(), fallback: createTab(newId(), Date.now()) });
  },
  restoreTab(id) {
    const restoredId = newId();
    get().dispatch({ type: "restore-tab", id, restoredId, now: Date.now() });
    return restoredId;
  },
  reset() {
    set((state) => ({ data: initialBrowserData(createTab(newId(), Date.now()), { ...state.data.preferences, hiddenElements: {} }) }));
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
// One save at a time: two writing the same temporary file at once lose one of them.
let saving: Promise<void> = Promise.resolve();
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!useBrowserStore.getState().ready) return;
  saving = saving.then(() => repository.save(useBrowserStore.getState().data)).catch((error: unknown) => console.warn("Couldn't save browsing state.", error));
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
    pruneSnapshots(keep).catch((error: unknown) => console.warn("Couldn't prune tab snapshots.", error));
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
