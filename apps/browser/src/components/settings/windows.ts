import { openWindow } from "@bay/shell";
import { create } from "zustand";
import { TASK_MANAGER_WINDOW_ID } from "../taskManager/window";

export const SETTINGS_WINDOW_ID = "settings";
export const IMPORT_WINDOW_ID = "import";

export const isUtilityWindowId = (id: string | null | undefined) => id === SETTINGS_WINDOW_ID || id === IMPORT_WINDOW_ID || id === TASK_MANAGER_WINDOW_ID;

export type SettingsPane =
  | "general"
  | "spaces"
  | "sync"
  | "tabs"
  | "appearance"
  | "privacy"
  | "passwords"
  | "autofill"
  | "extensions"
  | "search"
  | "shortcuts"
  | "links"
  | "liveFolders"
  | "calendar"
  | "advanced";

type Nav = {
  pane: SettingsPane;
  spaceId: string | null;
  back: { pane: SettingsPane; spaceId: string | null }[];
  forward: { pane: SettingsPane; spaceId: string | null }[];
  go(pane: SettingsPane, spaceId?: string | null): void;
  goBack(): void;
  goForward(): void;
};

export const useSettingsNav = create<Nav>((set, get) => ({
  pane: "general",
  spaceId: null,
  back: [],
  forward: [],
  go(pane, spaceId = null) {
    const { pane: from, spaceId: fromProfile, back } = get();
    if (from === pane && fromProfile === spaceId) return;
    set({ pane, spaceId, back: [...back, { pane: from, spaceId: fromProfile }].slice(-30), forward: [] });
  },
  goBack() {
    const { back, forward, pane, spaceId } = get();
    const prev = back.at(-1);
    if (prev) set({ ...prev, back: back.slice(0, -1), forward: [{ pane, spaceId }, ...forward] });
  },
  goForward() {
    const { back, forward, pane, spaceId } = get();
    const next = forward[0];
    if (next) set({ ...next, forward: forward.slice(1), back: [...back, { pane, spaceId }] });
  },
}));

export function openSettings(pane?: SettingsPane, spaceId?: string | null) {
  if (pane) useSettingsNav.getState().go(pane, spaceId ?? null);
  void openWindow(SETTINGS_WINDOW_ID, { kind: "settings", title: "Settings" });
}

export function openImport() {
  void openWindow(IMPORT_WINDOW_ID, { kind: "import", title: "Import from Another Browser" });
}
