import { create } from "zustand";
import type { Section } from "./sections";

// Arc's Library in the sidebar: it takes the sidebar's place (wider, for its rail and list) until you go back to tabs.
// The section it shows, per window; a window without one shows its tabs.
export const LIBRARY_SIDEBAR_WIDTH = 400;
export const LIBRARY_RAIL = 80;
// Spaces lie side by side, as Arc's do: a column each, the sidebar widening to hold them (and the + after them).
export const SPACE_COLUMN = 236;
export const SPACE_COLUMN_GAP = 12;
export const SPACES_PAD = 12;
export const NEW_SPACE_ROOM = 52;
// What's left of the page beside the widest Spaces.
const MIN_PAGE = 220;

export function libraryWidth(section: Section, spaceCount: number, windowWidth: number): number {
  if (section !== "spaces") return LIBRARY_SIDEBAR_WIDTH;
  const columns = spaceCount * SPACE_COLUMN + Math.max(0, spaceCount - 1) * SPACE_COLUMN_GAP;
  const wanted = LIBRARY_RAIL + SPACES_PAD + columns + NEW_SPACE_ROOM;
  return Math.max(LIBRARY_SIDEBAR_WIDTH, Math.min(wanted, windowWidth - MIN_PAGE));
}

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
