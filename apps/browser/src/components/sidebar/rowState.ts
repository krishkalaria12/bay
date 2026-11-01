import type { StoreApi } from "zustand/vanilla";
import { useBrowser, type BrowserState } from "../../store/browser";
import { activeTabId } from "../../store/model";
import { selectionStore, tabLiveStore, tabStore, windowsStore } from "../../store/views";

export const ACTIVE = 1;
export const SELECTED = 2;
export const PLAYING = 4;
export const LOADING = 8;

export function rowFlags(s: BrowserState, windowId: string, tabId: string): number {
  const tab = s.tabs[tabId];
  const live = s.live[tabId];
  let flags = 0;
  if (tab && activeTabId(s, windowId, tab.spaceId) === tabId) flags |= ACTIVE;
  if (s.selection[windowId]?.includes(tabId)) flags |= SELECTED;
  if (live?.playingAudio) flags |= PLAYING;
  if (live?.isLoading) flags |= LOADING;
  return flags;
}

// These flags depend on one tab, its live state, the window's selection and window ownership. In particular, another
// tab's progress must never ask every row to recompute them. Keep one scalar snapshot so a combined update renders once.
export function tabRowStore(windowId: string, tabId: string): Pick<StoreApi<number>, "getState" | "getInitialState" | "subscribe"> {
  const read = () => rowFlags(useBrowser.getState(), windowId, tabId);
  return {
    getState: read,
    getInitialState: () => rowFlags(useBrowser.getInitialState(), windowId, tabId),
    subscribe(listener) {
      let previous = read();
      const changed = () => {
        const next = read();
        if (next === previous) return;
        const before = previous;
        previous = next;
        listener(next, before);
      };
      const stops = [
        tabStore(tabId).subscribe(changed),
        tabLiveStore(tabId).subscribe(changed),
        selectionStore(windowId).subscribe(changed),
        // activeTabId also validates a tab's owning window, including a Little Bay in another window.
        windowsStore.subscribe(changed),
      ];
      return () => stops.forEach((stop) => stop());
    },
  };
}
