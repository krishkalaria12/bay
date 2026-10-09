import { createContext, useContext } from "react";
import { useShallow } from "zustand/react/shallow";
import { isBookmarked } from "./bookmarks";
import { useBrowser } from "./browser";
import { activeTabId, bookmarkSpaceId, IDLE_LIVE, spaceFor } from "./model";
import type { Settings } from "./settings";
import type { BrowserWindow, FindState, Space, Tab, TabLive } from "./types";
import { CLOSED_FIND, DEFAULT_WINDOW_UI } from "./ui";

export const WindowContext = createContext<string | null>(null);

// Outside any window's tree: the focused window, read, not followed.
const focusedWindowId = () => useBrowser.getState().ui.focusedWindowId ?? "";

export function useWindowId(): string {
  return useContext(WindowContext) ?? focusedWindowId();
}

export function useWindowField<T>(select: (w: BrowserWindow) => T, fallback: T): T {
  const id = useWindowId();
  return useBrowser((s) => {
    const w = s.windows[id];
    return w ? select(w) : fallback;
  });
}

export const PageSpaceContext = createContext<string | null>(null);

export function usePageSpaceId(): string {
  const page = useContext(PageSpaceContext);
  const own = useWindowSpaceId();
  return page ?? own;
}

export const useIsIncognito = () => useWindowField((w) => w.incognito, false);
export const useSidebarOpen = () => useWindowField((w) => w.sidebarOpen, true);
export const useWindowSpaceId = () => useWindowField((w) => w.spaceId, "");

export function useWindowSpace(): Space {
  const spaceId = useWindowSpaceId();
  return useBrowser((s) => spaceFor(s, spaceId));
}

export const useSpaces = (): Space[] => useBrowser(useShallow((s) => s.spaceOrder.map((id) => s.spaces[id]!)));

export function useActiveTabId(): string | undefined {
  const id = useWindowId();
  return useBrowser((s) => activeTabId(s, id));
}

export function useActiveTab(): Tab | undefined {
  const id = useWindowId();
  return useBrowser((s) => {
    const active = activeTabId(s, id);
    return active ? s.tabs[active] : undefined;
  });
}

export const useIsActiveTab = (tabId: string) =>
  useBrowser((s) => {
    const tab = s.tabs[tabId];
    return !!tab && activeTabId(s, tab.windowId, tab.spaceId) === tabId;
  });

export const useTab = (tabId: string | undefined): Tab | undefined => useBrowser((s) => (tabId ? s.tabs[tabId] : undefined));

export function useTabLive(tabId: string | undefined): TabLive;
export function useTabLive<T>(tabId: string | undefined, select: (live: TabLive) => T): T;
export function useTabLive<T>(tabId: string | undefined, select?: (live: TabLive) => T) {
  return useBrowser((s) => {
    const live = (tabId && s.live[tabId]) || IDLE_LIVE;
    return select ? select(live) : live;
  });
}

export const useFind = (tabId: string | undefined): FindState => useBrowser((s) => (tabId && s.find[tabId]) || CLOSED_FIND);

export function useWindowUi() {
  const id = useWindowId();
  return useBrowser((s) => s.windowUi[id] ?? DEFAULT_WINDOW_UI);
}

export const useSettings = <T>(select: (settings: Settings) => T): T => useBrowser((s) => select(s.settings));

export function useIsBookmarked(url: string): boolean {
  const id = useWindowId();
  return useBrowser((s) => isBookmarked(s.bookmarks, bookmarkSpaceId(s, s.windows[id]), url));
}
