import { focus, openWindow } from "../../lib/actions";
import { useBrowser } from "../../store/browser";
import { activeTabId, viewTabIds } from "../../store/model";
import { isSmall, mainWindowFor } from "../../store/small";

const store = () => useBrowser.getState();

// ⌘⌥N, and links from other apps. Without a page the bar's field opens, ready to type.
export function openLittleBay(url?: string, spaceId?: string): string {
  const id = store().createWindow({ small: true, url, spaceId });
  if (!url) store().openPanel(id, "");
  return id;
}

const opensInLittleBay = (url: string) => /^(https?|file):/i.test(url);

// URLs from other apps (Launch Services, `open`, Handoff) open in the default profile (Settings › Profiles). With
// Settings › General › "Open links from other apps in" Little Bay, one web link opens in its own Little Bay, even when a
// Little Bay is already in front; several at once, or set to a new tab, they open as tabs of the main window.
export function openExternalUrls(urls: string[]) {
  const [url] = urls;
  const spaceId = store().settings.defaultSpaceId;
  if (store().settings.openLinksInLittleBay && urls.length === 1 && url && opensInLittleBay(url)) return void openLittleBay(url, spaceId);
  openLinksInMainWindow(urls, spaceId);
}

// New tabs in the frontmost main window showing the profile (else the frontmost main window, paged to it), which
// comes forward; a new window when there's none. The blank window a launch opens takes the first link itself.
function openLinksInMainWindow(urls: string[], spaceId: string) {
  let target = mainWindowFor(store(), spaceId);
  for (const url of urls) {
    const s = store();
    const w = target ? s.windows[target] : undefined;
    const view = target ? viewTabIds(s, target) : [];
    const blank = w && view.length === 1 ? s.tabs[view[0]!] : undefined;
    if (!w) target = openWindow({ url, spaceId });
    else if (blank && !blank.url && !blank.navigation && blank.spaceId === spaceId && !s.windowUi[w.id]?.panel.open) s.navigate(blank.id, url);
    else s.newTab(w.id, { url, spaceId });
  }
  if (target) focus(target);
}

// ⌘O / the bar's button: the live page (history, scroll, playback) moves into the frontmost main window of its
// profile, which opens if there's none, and Little Bay closes with it.
export function openInMainWindow(windowId: string) {
  const s = store();
  if (!isSmall(s, windowId)) return;
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const target = mainWindowFor(s, tab?.spaceId ?? s.windows[windowId]!.spaceId);
  if (!tab?.url) {
    s.closeWindow(windowId);
    if (target) focus(target);
    else openWindow({ spaceId: tab?.spaceId });
    return;
  }
  const moved = s.moveTabsToWindow([tab.id], target ?? null);
  if (moved) focus(moved);
}

export function closeLittleBay(windowId: string) {
  if (isSmall(store(), windowId)) store().closeWindow(windowId);
}

// An Esc the page didn't want (not typed into a field, no page full screen) closes Little Bay.
export function closeLittleBayOnEscape(tabId: string) {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || !isSmall(s, tab.windowId) || s.find[tabId]?.open || s.windowUi[tab.windowId]?.panel.open) return;
  closeLittleBay(tab.windowId);
}
