import { create } from "zustand";
import { layout } from "../../lib/constants";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection as BrowserState } from "../../runtime/projection";
import { useWindowId } from "../../store/hooks";
import { developerTabShown } from "../developer/sites";
import { SIDEBAR_FIELD } from "./constants";

export function useTabLayout(): "sidebar" | "top" {
  const windowId = useWindowId();
  return useBrowser((s) => s.windows[windowId]?.tabLayout ?? s.settings.tabLayout);
}

// Closed, the sidebar keeps it: the page fills the window, and the field is in the sidebar's peek.
export function addressBarInSidebar(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && s.settings.addressBar === "sidebar" && (w.tabLayout ?? s.settings.tabLayout) === "sidebar";
}

export function useAddressBarInSidebar(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => addressBarInSidebar(s, windowId));
}

// The sidebar's address field, shown unless the window's tab is in Developer Mode: its address is over its page then.
export function sidebarFieldShown(s: BrowserState, windowId: string): boolean {
  return addressBarInSidebar(s, windowId) && !developerTabShown(s, windowId);
}

export function useSidebarFieldShown(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => sidebarFieldShown(s, windowId));
}

// The sidebar docked on the window's right (Appearance › Sidebar): the page on the left, under the window buttons.
export function sidebarOnRight(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && s.settings.sidebarPosition === "right" && (w.tabLayout ?? s.settings.tabLayout) === "sidebar";
}

export function useSidebarOnRight(): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => sidebarOnRight(s, windowId));
}

// The sidebar toggle's symbol: the sidebar drawn on the side it's on.
export const useSidebarSymbol = () => (useSidebarOnRight() ? "sidebar.right" : "sidebar.left");

// A card beside a sidebar row, in the window: past the row's edge toward the page. On the right it stays inside the
// window's left edge, over the sidebar if a narrow window leaves it no room.
export function besideRow(anchor: { x: number; width: number }, width: number, right: boolean, gap = 8): number {
  return right ? Math.max(8, anchor.x - gap - width) : anchor.x + anchor.width + gap;
}

export function listTopGap(addressBar: boolean): number {
  return addressBar ? 6 : layout.pinnedTop - layout.sidebarHeader;
}

export type UrlAnchor = { left: number; top: number; width: number; sidebar?: { height: number } };

export function sidebarSiteControlsGeometry(anchor: UrlAnchor, windowWidth: number, windowHeight: number) {
  const width = Math.min(306, Math.max(0, windowWidth - 16));
  // The controls button is the last 28pt accessory, with a 3pt inset at the field's right edge.
  const buttonCenter = anchor.left + anchor.width - 17;
  const left = Math.max(8, Math.min(buttonCenter - width / 2, windowWidth - width - 8));
  const top = anchor.top + (anchor.sidebar?.height ?? SIDEBAR_FIELD.height) + 9;
  return { width, left, top, arrowLeft: buttonCenter - left, maxHeight: Math.max(0, windowHeight - top - 8) };
}

export const useUrlAnchors = create<Record<string, UrlAnchor>>()(() => ({}));

export function setUrlAnchor(windowId: string, anchor: UrlAnchor) {
  const current = useUrlAnchors.getState()[windowId];
  if (
    current &&
    current.left === anchor.left &&
    current.top === anchor.top &&
    current.width === anchor.width &&
    current.sidebar?.height === anchor.sidebar?.height
  )
    return;
  useUrlAnchors.setState({ [windowId]: anchor });
}
