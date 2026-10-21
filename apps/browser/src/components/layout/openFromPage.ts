import type { OpenWindowRequest } from "@bay/nncore";
import { openWindow } from "../../lib/actions";
import { reportBrowserCommand } from "../../runtime/commands";
import { navigate, newTab } from "../../runtime/tabActions";
import { useBrowser as legacyBrowser } from "../../store/browser";
import { engineProfileFor } from "../../store/model";
import { browserRead } from "../../store/read";
import { pageFactsInCoordinator } from "../../lib/pageFactOwnership";
import { opensInPeek } from "../../store/peeks";
import { isSmall } from "../../store/small";
import { openPeek } from "../../runtime/splitActions";
import { openLinkInSplit, openPageInSplit } from "./splitActions";

// Where a page's new tab, window or split goes (the engine's openWindow): one place for tabs, extension
// popups and side panels. `tabId` is the page's tab, the new tab's opener; extension pages have none.
export function openFromPage({ url, adoptId, disposition }: OpenWindowRequest, from: { windowId: string; spaceId: string; tabId?: string }) {
  // Chrome offers these pages directly to the authority. A window callback
  // must not create another tab or try to move the offered page itself.
  if (adoptId && pageFactsInCoordinator()) return;
  const s = browserRead.getState();
  const w = s.windows[from.windowId];
  if (!w) return;
  if (disposition === "current") {
    if (from.tabId) reportBrowserCommand(navigate(from.tabId, url, { userInitiated: false }));
    return;
  }
  // Links stay in Little Bay; new tabs (target=_blank, ⌘-click, split) open behind, in a main window.
  if (isSmall(s, w.id) && disposition !== "window" && disposition !== "incognito") {
    if (adoptId) return void legacyBrowser.getState().newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background: true });
    return reportBrowserCommand(newTab(w.id, { url, openerId: from.tabId, spaceId: from.spaceId, background: true }));
  }
  if (disposition === "split") {
    if (from.tabId) return openLinkInSplit(from.tabId, url, adoptId);
    return openPageInSplit(w.id, url, adoptId);
  }
  if (disposition === "incognito") {
    // A private tab Chrome already made (an extension's incognito window, Open Link in Incognito Window) moves in
    // live; anything else loads afresh in the private window.
    if (adoptId?.startsWith("tab:")) return void legacyBrowser.getState().createWindow({ incognito: true, url, adoptId });
    return reportBrowserCommand(openWindow({ incognito: true, url }));
  }
  // A private window's new window is private too: a session of its own, so the page loads afresh there.
  if (disposition === "window") {
    if (!w.incognito && adoptId) return void legacyBrowser.getState().createWindow({ spaceId: from.spaceId, url, adoptId });
    return reportBrowserCommand(openWindow(w.incognito ? { incognito: true, url } : { spaceId: from.spaceId, url }));
  }
  // A link a pinned tab or a favourite opens in front: a peek over its page, as Arc's (store/peeks.ts).
  if (disposition === "foreground" && from.tabId && opensInPeek(s, from.tabId, url)) {
    if (adoptId) return void legacyBrowser.getState().openPeek(from.tabId, url, adoptId);
    return reportBrowserCommand(openPeek(from.tabId, url));
  }
  const background = disposition === "background";
  if (adoptId) legacyBrowser.getState().newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background });
  else reportBrowserCommand(newTab(w.id, { url, openerId: from.tabId, spaceId: from.spaceId, background }));
}

// The store profile of a page outside tabs (an extension popup or side panel): its engine profile's.
export function pageSpaceId(windowId: string, pageProfile: string): string {
  const s = browserRead.getState();
  const w = s.windows[windowId];
  if (w && engineProfileFor(w.spaceId, s.spaces) === pageProfile) return w.spaceId;
  return s.spaceOrder.find((p) => engineProfileFor(p, s.spaces) === pageProfile) ?? w?.spaceId ?? s.settings.defaultSpaceId;
}
