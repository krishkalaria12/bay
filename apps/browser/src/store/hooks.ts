import { createContext, useContext, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isBookmarked } from "./bookmarks";
import { useBrowserRead as useBrowser } from "./read";
import type { QuietBrowserState } from "./browserStore";
import { activeTabId, bookmarkSpaceId, IDLE_LIVE, spaceFor } from "./model";
import type { Settings } from "./settings";
import type { DeepReadonly } from "../runtime/projection";
import type { BrowserWindow, FindState, Space, Tab, TabLive } from "./types";
import { CLOSED_FIND, DEFAULT_WINDOW_UI } from "./windowUi";
import { findStore, quietStore, settingsStore, spaceHeaderHiddenStore, spaceStore, tabLiveStore, tabStore, windowStore, windowUiStore } from "./derivedStores";

export const WindowContext = createContext<string | null>(null);

// Outside any window's tree: the focused window, read, not followed.
const focusedWindowId = () => useBrowser.getState().ui.focusedWindowId ?? "";

export function useWindowId(): string {
  return useContext(WindowContext) ?? focusedWindowId();
}

export function useWindowField<T>(select: (w: DeepReadonly<BrowserWindow>) => T, fallback: T): T {
  const id = useWindowId();
  const view = useMemo(() => windowStore(id), [id]);

  return useStore(view, (w) => (w ? select(w) : fallback));
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

export function useWindowSpace(): DeepReadonly<Space> {
  const spaceId = useWindowSpaceId();

  return useQuietBrowser((s) => spaceFor(s, spaceId));
}

export const useSpaces = (): DeepReadonly<Space>[] => useQuietBrowser(useShallow((s) => s.spaceOrder.map((id) => s.spaces[id]!)));

export function useActiveTabId(): string | undefined {
  const id = useWindowId();

  return useQuietBrowser((s) => activeTabId(s, id));
}

export function useActiveTab(): DeepReadonly<Tab> | undefined {
  const id = useWindowId();

  return useQuietBrowser((s) => {
    const active = activeTabId(s, id);

    return active ? s.tabs[active] : undefined;
  });
}

/** Whether the window it's drawn in (every window on its space lists it) shows the tab. */
export function useIsActiveTab(tabId: string): boolean {
  const windowId = useWindowId();

  return useQuietBrowser((s) => {
    const tab = s.tabs[tabId];

    return !!tab && activeTabId(s, windowId || tab.windowId, tab.spaceId) === tabId;
  });
}

export function useSpaceFolded(spaceId: string): boolean {
  const view = useMemo(() => spaceStore(spaceId), [spaceId]);
  const folded = useStore(view, (space) => !!space?.folded);
  const headerHidden = useStore(spaceHeaderHiddenStore);

  return folded && !headerHidden;
}

export function useTab(tabId: string | undefined): DeepReadonly<Tab> | undefined;
export function useTab<T>(tabId: string | undefined, select: (tab: DeepReadonly<Tab> | undefined) => T): T;
export function useTab<T>(tabId: string | undefined, select?: (tab: DeepReadonly<Tab> | undefined) => T) {
  const view = useMemo(() => tabStore(tabId ?? ""), [tabId]);

  return useStore(view, (tab) => (select ? select(tab) : tab));
}

export function useTabLive(tabId: string | undefined): DeepReadonly<TabLive>;
export function useTabLive<T>(tabId: string | undefined, select: (live: DeepReadonly<TabLive>) => T): T;
export function useTabLive<T>(tabId: string | undefined, select?: (live: DeepReadonly<TabLive>) => T) {
  const view = useMemo(() => tabLiveStore(tabId ?? ""), [tabId]);

  return useStore(view, (value) => {
    const live = value ?? IDLE_LIVE;

    return select ? select(live) : live;
  });
}

export function useFind(tabId: string | undefined): DeepReadonly<FindState> {
  const view = useMemo(() => findStore(tabId ?? ""), [tabId]);

  return useStore(view, (find) => find ?? CLOSED_FIND);
}

export function useWindowUi() {
  const id = useWindowId();
  const view = useMemo(() => windowUiStore(id), [id]);

  return useStore(view, (ui) => ui ?? DEFAULT_WINDOW_UI);
}

/** Select durable state without running on page progress. */
export const useQuietBrowser = <T>(select: (s: QuietBrowserState) => T): T => useStore(quietStore, select);

export const useSettings = <T>(select: (settings: DeepReadonly<Settings>) => T): T => useStore(settingsStore, select);

export function useIsBookmarked(url: string): boolean {
  const id = useWindowId();

  return useQuietBrowser((s) => isBookmarked(s.bookmarks, bookmarkSpaceId(s, s.windows[id]), url));
}
