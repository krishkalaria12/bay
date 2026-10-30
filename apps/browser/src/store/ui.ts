import type { Download } from "@bay/nncore";
import type { StateCreator } from "zustand";
import type { BrowserProjection } from "../runtime/projection";
import type { BrowserState } from "./browser";
import { isIncognitoSpace, newId } from "./model";
import type { FindState, Space, WindowUi } from "./types";
import { MAX_DOWNLOADS } from "./constants";

export type UiSlice = {
  ui: {
    focusedWindowId: string | null;
    focusOrder: string[];
    appDark: boolean;
    // Looks shown on windows before they're a space's (the new space panel's Look step), by window. Not saved.
    previewLooks?: Record<string, Pick<Space, "color" | "theme" | "followSite">>;
  };
  windowUi: Record<string, WindowUi>;
  find: Record<string, FindState>;
  downloads: Download[];

  setFocusedWindow(id: string): void;
  setAppDark(dark: boolean): void;
  openPanel(windowId: string, initialText?: string): void;
  openNewTabPanel(windowId: string, groupId?: string): void;
  submitNewTabPanel(windowId: string, url: string): string;
  closePanel(windowId: string): void;
  setDownloadsOpen(windowId: string, open: boolean): void;
  setFind(tabId: string, patch: Partial<FindState>): void;
  upsertDownload(d: Download): void;
  updateDownloadFile(id: string, patch: { filename: string; path: string }): void;
  removeDownload(id: string): void;
  clearDownloads(windowId?: string): void;
  forgetDownloads(profile: string): void;
};

export function downloadVisibleIn(d: Pick<Download, "profile">, window: { incognito: boolean; spaceId: string } | undefined): boolean {
  if (!window) return false;
  const incognito = !!d.profile && isIncognitoSpace(d.profile);
  return window.incognito ? d.profile === window.spaceId : !incognito;
}

export const downloadsIn = (s: Pick<BrowserProjection, "downloads" | "windows">, windowId: string) =>
  s.downloads.filter((d) => downloadVisibleIn(d, s.windows[windowId]));

export const DEFAULT_WINDOW_UI: WindowUi = { panel: { open: false, initialText: "" }, downloadsOpen: false };
export const CLOSED_FIND: FindState = { open: false, query: "", count: null, active: 0 };

function patchWindowUi(s: BrowserState, windowId: string, patch: Partial<WindowUi>): Partial<BrowserState> {
  if (!s.windows[windowId]) return {};
  return { windowUi: { ...s.windowUi, [windowId]: { ...(s.windowUi[windowId] ?? DEFAULT_WINDOW_UI), ...patch } } };
}

export const createUiSlice: StateCreator<BrowserState, [], [], UiSlice> = (set, get) => ({
  ui: { focusedWindowId: null, focusOrder: [], appDark: true },
  windowUi: {},
  find: {},
  downloads: [],

  setFocusedWindow(id) {
    const { ui, windows } = get();
    if (!windows[id] || ui.focusedWindowId === id) return;
    set({ ui: { ...ui, focusedWindowId: id, focusOrder: [id, ...ui.focusOrder.filter((w) => w !== id)] } });
  },

  setAppDark(appDark) {
    if (get().ui.appDark !== appDark) set((s) => ({ ui: { ...s.ui, appDark } }));
  },

  openPanel(windowId, initialText = "") {
    // One of the palette and the downloads panel at a time: the one opened last.
    set((s) => patchWindowUi(s, windowId, { panel: { open: true, initialText, mode: "navigate", sessionId: newId("panel") }, downloadsOpen: false }));
  },

  openNewTabPanel(windowId, groupId) {
    const s = get();
    const window = s.windows[windowId];
    const group = groupId ? s.groups[groupId] : undefined;
    if (!window || window.kind === "small" || (groupId && (!group || group.spaceId !== window.spaceId))) return;
    set(
      patchWindowUi(s, windowId, {
        panel: { open: true, initialText: "", mode: "newTab", sessionId: newId("panel"), ...(groupId ? { groupId } : {}) },
        downloadsOpen: false,
      }),
    );
  },

  submitNewTabPanel(windowId, url) {
    const s = get();
    const window = s.windows[windowId];
    const panel = s.windowUi[windowId]?.panel;
    if (!window || window.kind === "small" || !url.trim() || !panel?.open || panel.mode !== "newTab") return "";
    if (panel.groupId) {
      const group = s.groups[panel.groupId];
      if (!group || group.spaceId !== window.spaceId) {
        s.closePanel(windowId);
        return "";
      }
    }
    // Close first: internal URLs can open a fresh panel through the app-URL handler.
    s.closePanel(windowId);
    return panel.groupId ? get().newTabInGroup(panel.groupId, url) : get().newTab(windowId, { url });
  },

  closePanel(windowId) {
    set((s) => patchWindowUi(s, windowId, { panel: { open: false, initialText: "" } }));
  },

  setDownloadsOpen(windowId, downloadsOpen) {
    set((s) => patchWindowUi(s, windowId, downloadsOpen ? { downloadsOpen, panel: { open: false, initialText: "" } } : { downloadsOpen }));
  },

  setFind(tabId, patch) {
    set((s) => (s.tabs[tabId] ? { find: { ...s.find, [tabId]: { ...(s.find[tabId] ?? CLOSED_FIND), ...patch } } } : {}));
  },

  upsertDownload(d) {
    set((s) => {
      const exists = s.downloads.some((x) => x.id === d.id);
      // A private window's downloads leave with it; the engine's late "cancelled" update mustn't bring one back.
      if (!exists && d.profile && isIncognitoSpace(d.profile) && !Object.values(s.windows).some((w) => w.spaceId === d.profile)) {
        return {};
      }
      // Chromium still names the path it saved after Tidy Downloads renamed the file; the renamed one stands.
      const keep = (x: Download): Download => (x.renamedFrom === d.path ? { ...d, filename: x.filename, path: x.path, renamedFrom: x.renamedFrom } : d);
      // A new download doesn't open the panel: the magnet flies its icon to the downloads button instead.
      return { downloads: exists ? s.downloads.map((x) => (x.id === d.id ? keep(x) : x)) : [d, ...s.downloads].slice(0, MAX_DOWNLOADS) };
    });
  },

  updateDownloadFile(id, patch) {
    set((s) => ({
      downloads: s.downloads.map((d) => {
        if (d.id !== id) return d;
        const saved = d.renamedFrom ?? d.path;
        const { renamedFrom: _, ...rest } = d;
        return { ...rest, filename: patch.filename, path: patch.path, ...(patch.path === saved ? {} : { renamedFrom: saved }) };
      }),
    }));
  },

  removeDownload(id) {
    set((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }));
  },

  clearDownloads(windowId) {
    set((s) => ({
      downloads: s.downloads.filter((d) => d.state === "downloading" || (windowId !== undefined && !downloadVisibleIn(d, s.windows[windowId]))),
    }));
  },

  forgetDownloads(profile) {
    set((s) => (s.downloads.some((d) => d.profile === profile) ? { downloads: s.downloads.filter((d) => d.profile !== profile) } : {}));
  },
});
