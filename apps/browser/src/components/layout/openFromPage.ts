import type { OpenWindowRequest } from "@bay/nncore";
import { openWindow } from "../../lib/actions";
import { reportBrowserCommand } from "../../runtime/commands";
import { navigate, newTab } from "../../runtime/tabActions";
import { useBrowser } from "../../store/browser";
import { engineProfile } from "../../store/model";
import { opensInPeek } from "../../store/peeks";
import { isSmall } from "../../store/small";
import { openLinkInSplit, openSplitPane } from "./splitActions";

// Where a page's new tab, window or split goes (the engine's openWindow): one place for tabs, extension
// popups and side panels. `tabId` is the page's tab, the new tab's opener; extension pages have none.
export function openFromPage({ url, adoptId, disposition }: OpenWindowRequest, from: { windowId: string; spaceId: string; tabId?: string }) {
  const s = useBrowser.getState();
  const w = s.windows[from.windowId];
  if (!w) return;
  if (disposition === "current") {
    if (from.tabId) reportBrowserCommand(navigate(from.tabId, url, { userInitiated: false }));
    return;
  }
  // Links stay in Little Bay; new tabs (target=_blank, ⌘-click, split) open behind, in a main window.
  if (isSmall(s, w.id) && disposition !== "window" && disposition !== "incognito") {
    if (adoptId) return void s.newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background: true });
    return reportBrowserCommand(newTab(w.id, { url, openerId: from.tabId, spaceId: from.spaceId, background: true }));
  }
  if (disposition === "split") {
    if (from.tabId) return openLinkInSplit(from.tabId, url, adoptId);
    openSplitPane(w.id, { url, adoptId });
    return;
  }
  if (disposition === "incognito") {
    // A private tab Chrome already made (an extension's incognito window, Open Link in Incognito Window) moves in
    // live; anything else loads afresh in the private window.
    if (adoptId?.startsWith("tab:")) return void s.createWindow({ incognito: true, url, adoptId });
    return reportBrowserCommand(openWindow({ incognito: true, url }));
  }
  // A private window's new window is private too: a session of its own, so the page loads afresh there.
  if (disposition === "window") {
    if (!w.incognito && adoptId) return void s.createWindow({ spaceId: from.spaceId, url, adoptId });
    return reportBrowserCommand(openWindow(w.incognito ? { incognito: true, url } : { spaceId: from.spaceId, url }));
  }
  // A link a pinned tab or a favourite opens in front: a peek over its page, as Arc's (store/peeks.ts).
  if (disposition === "foreground" && from.tabId && opensInPeek(s, from.tabId, url)) {
    s.openPeek(from.tabId, url, adoptId);
    return;
  }
  const background = disposition === "background";
  if (adoptId) s.newTab(w.id, { url, adoptId, openerId: from.tabId, spaceId: from.spaceId, background });
  else reportBrowserCommand(newTab(w.id, { url, openerId: from.tabId, spaceId: from.spaceId, background }));
}

// The store profile of a page outside tabs (an extension popup or side panel): its engine profile's.
export function pageSpaceId(windowId: string, pageProfile: string): string {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (w && engineProfile(w.spaceId) === pageProfile) return w.spaceId;
  return s.spaceOrder.find((p) => engineProfile(p) === pageProfile) ?? w?.spaceId ?? s.settings.defaultSpaceId;
}
