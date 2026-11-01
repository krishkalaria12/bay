import { create } from "zustand";
import type { Section } from "./sections";

// Arc's Library in the sidebar: it takes the sidebar's place (wider, for its rail and list) until you go back to tabs.
// The section it shows, per window; a window without one shows its tabs.
export const LIBRARY_SIDEBAR_WIDTH = 360;

export const useLibrarySidebar = create<Record<string, Section>>(() => ({}));

export const librarySidebarOpen = (windowId: string) => !!useLibrarySidebar.getState()[windowId];

export function showLibrarySidebar(windowId: string, section: Section) {
  if (useLibrarySidebar.getState()[windowId] !== section) useLibrarySidebar.setState({ [windowId]: section });
}

export function closeLibrarySidebar(windowId: string) {
  if (!librarySidebarOpen(windowId)) return;
  useLibrarySidebar.setState((s) => {
    const next = { ...s };
    delete next[windowId];
    return next;
  }, true);
}
