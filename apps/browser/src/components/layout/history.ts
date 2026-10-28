import { create } from "zustand";
import { goBackAcrossEngines } from "../../lib/engines";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { dispatchBrowserCommand, reportBrowserCommand } from "../../runtime/commands";
import { changedIds } from "../../store/changes";
import { useTabLive } from "../../store/hooks";
import type { TabLive } from "../../store/types";
import { internalPageOf, tabDestination } from "../pages/urls";
import { pageOf, patchPage, usePage } from "./pageState";

const store = () => useBrowser.getState();
// The page Back left for a New Tab page, kept for Forward (store/tabs.ts keeps it in the tab, so every window sees it).
const keptPage = (tabId: string) => store().tabs[tabId]?.newTabHistory;

export function canGoBack(tabId: string, live: Pick<TabLive, "canGoBack">): boolean {
  const page = pageOf(tabId);
  return !keptPage(tabId) && (live.canGoBack || page.backToNewTab || !!page.engineBack);
}

export function canGoForward(tabId: string, live: Pick<TabLive, "canGoForward">): boolean {
  return !!keptPage(tabId) || live.canGoForward;
}

// Subscribes to the two flags only, so a page's progress and audio reports don't re-render the buttons' owner.
export function useHistoryAvailability(tabId: string) {
  const back = useTabLive(tabId, (l) => l.canGoBack);
  const forward = useTabLive(tabId, (l) => l.canGoForward);
  const shown = useBrowser((s) => !!s.tabs[tabId]?.newTabHistory);
  const backToNewTab = usePage(tabId, (p) => p.backToNewTab || !!p.engineBack);
  return { back: !shown && (back || backToNewTab), forward: shown || forward };
}

export function goBack(tabId: string) {
  const live = store().live[tabId];
  if (keptPage(tabId)) return;
  if (live?.canGoBack) return void webviews.get(tabId)?.goBack();
  if (pageOf(tabId).engineBack) return void goBackAcrossEngines(tabId);
  if (pageOf(tabId).backToNewTab) showNewTab(tabId);
}

export function goForward(tabId: string) {
  if (keptPage(tabId)) return hideNewTab(tabId);
  void webviews.get(tabId)?.goForward();
}

function showNewTab(tabId: string, keep?: { url: string; title: string }) {
  const tab = store().tabs[tabId];
  if (!tab?.url) return;
  patchPage(tabId, { status: "" });
  reportBrowserCommand(dispatchBrowserCommand({ method: "showNewTab", tabId, ...(keep ? { first: keep } : {}) }));
}

export function goBackToNewTab(tabId: string, offset: number, first: { url: string; title: string }) {
  if (!pageOf(tabId).backToNewTab || keptPage(tabId)) return;
  if (offset) void webviews.get(tabId)?.goToOffset(offset);
  showNewTab(tabId, offset ? first : undefined);
}

function hideNewTab(tabId: string) {
  if (!keptPage(tabId)) return;
  reportBrowserCommand(dispatchBrowserCommand({ method: "hideNewTab", tabId }));
}

useBrowser.subscribe((s, prev) => {
  for (const id of changedIds(s.tabs, prev.tabs)) {
    const tab = s.tabs[id];
    const before = prev.tabs[id];
    if (!tab || !before) continue;
    if (!tabDestination(before) && internalPageOf(tabDestination(tab)) && !pageOf(id).backToNewTab) patchPage(id, { backToNewTab: true });
  }
});

// MARK: History lists (the back / forward popover, the swipe overlay's destinations)

export type HistoryItem = {
  key: string;
  title: string;
  url: string;
  offset: number | "newTab";
};

/** The favicons the profile's history has for `items`, as of the call (a menu's rows don't follow history). */
/** The favicons the profile's history holds for `items`, followed as the history changes. */
export function useHistoryFavicons(spaceId: string, items: HistoryItem[]): Map<string, string | null> {
  const history = useBrowser((s) => s.history[spaceId]);
  const urls = new Set(items.map((i) => i.url));
  return new Map((history ?? []).filter((h) => urls.has(h.url)).map((h) => [h.url, h.favicon]));
}

export async function historyItems(tabId: string, direction: -1 | 1, max = 15): Promise<HistoryItem[]> {
  const page = pageOf(tabId);
  const list = (await webviews.get(tabId)?.navigationEntries()) ?? [];
  const current = list.findIndex((e) => e.current);
  const kept = keptPage(tabId);
  if (kept) {
    if (direction < 0) return [];
    const items: HistoryItem[] = [];
    for (let i = Math.max(current, 0); i < list.length && items.length < max; i++) {
      const e = list[i]!;
      items.push({ key: String(i), title: e.title || e.url, url: e.url, offset: i - current });
    }
    if (!items.length) items.push({ key: "kept", title: kept.title || kept.url, url: kept.url, offset: 0 });
    return items;
  }
  const items: HistoryItem[] = [];
  if (current >= 0) {
    for (let i = current + direction; i >= 0 && i < list.length && items.length < max; i += direction) {
      const e = list[i]!;
      items.push({ key: String(i), title: e.title || e.url, url: e.url, offset: i - current });
    }
  }
  if (direction < 0 && page.backToNewTab && items.length < max) items.push({ key: "newTab", title: "New Tab", url: "", offset: "newTab" });
  return items;
}

export async function goToHistoryItem(tabId: string, item: HistoryItem) {
  if (item.offset === "newTab") {
    const list = (await webviews.get(tabId)?.navigationEntries()) ?? [];
    const current = list.findIndex((e) => e.current);
    if (current <= 0 || !list[0]) return goBack(tabId);
    return goBackToNewTab(tabId, -current, list[0]);
  }
  if (keptPage(tabId)) {
    hideNewTab(tabId);
    if (item.offset) void webviews.get(tabId)?.goToOffset(item.offset);
    return;
  }
  if (item.offset === -1) return goBack(tabId);
  if (item.offset === 1) return goForward(tabId);
  if (item.offset) void webviews.get(tabId)?.goToOffset(item.offset);
}

export type HistoryMenu = { tabId: string; direction: -1 | 1; items: HistoryItem[] };
export const useHistoryMenu = create<{ menu: HistoryMenu | null }>(() => ({ menu: null }));

export async function openHistoryMenu(tabId: string, direction: -1 | 1) {
  const items = await historyItems(tabId, direction);
  if (!items.length) return;
  useHistoryMenu.setState({ menu: { tabId, direction, items } });
}

export const closeHistoryMenu = () => useHistoryMenu.setState({ menu: null });
