import { modKey } from "@bay/platform";
import { openWindow, switchToTab } from "../../lib/actions";
import { useBrowser } from "../../store/browser";

export type Disposition = "current" | "newTab" | "newWindow";

export function dispositionFor(mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): Disposition {
  if (modKey(mods) || mods.altKey) return "newTab";
  if (mods.shiftKey) return "newWindow";
  return "current";
}

export function openFromBar(url: string, tabId: string, disposition: Disposition) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!url || !tab) return;
  const w = s.windows[tab.windowId];
  if (disposition === "current") return s.navigate(tabId, url);
  s.closePanel(tab.windowId);
  if (disposition === "newTab") return void s.newTab(tab.windowId, { url, spaceId: tab.spaceId, openerId: tab.url ? tabId : undefined });
  openWindow(w?.incognito ? { incognito: true, url } : { spaceId: tab.spaceId, url });
}

export function openInBackground(url: string, barTabId: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[barTabId];
  if (!url || !tab) return;
  s.newTab(tab.windowId, { url, spaceId: tab.spaceId, background: true });
}

export function switchFromBar(targetTabId: string, url: string, barTabId: string, disposition: Disposition) {
  if (disposition !== "current") return openFromBar(url, barTabId, disposition);
  const s = useBrowser.getState();
  const bar = s.tabs[barTabId];
  if (bar) s.closePanel(bar.windowId);
  switchToTab(targetTabId);
}

// A cleaned up tab goes back where it was, in its space, and the bar switches to it; false if it's no longer there.
export function restoreFromBar(entryId: string, barTabId: string): boolean {
  const s = useBrowser.getState();
  const bar = s.tabs[barTabId];
  const restored = s.restoreCleaned(entryId, bar?.windowId);
  if (!restored) return false;
  if (bar) s.closePanel(bar.windowId);
  switchToTab(restored);
  return true;
}
