import { create } from "zustand";
import { layout } from "../../lib/theme";
import { useBrowser, type BrowserState } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { developerTabShown } from "../developer/sites";

export function useTabLayout(): "sidebar" | "top" {
  const windowId = useWindowId();
  return useBrowser((s) => s.windows[windowId]?.tabLayout ?? s.settings.tabLayout);
}

export function addressBarInSidebar(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && s.settings.addressBar === "sidebar" && w.sidebarOpen && (w.tabLayout ?? s.settings.tabLayout) === "sidebar";
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

// yab: a 32pt field.
export const SIDEBAR_FIELD = { top: 48, height: 32, radius: 10 } as const;
// The space switcher's + mirrored: a 28pt button centred on the 41pt footer's band (3pt short of its bottom).
export const SIDEBAR_FOOTER_DOWNLOADS = { bottom: 3 + (41 - 3 - 28) / 2, size: 28 } as const;
export function listTopGap(addressBar: boolean): number {
  return addressBar ? 6 : layout.pinnedTop - layout.sidebarHeader;
}

export const SIDEBAR_HEADER_WITH_FIELD = SIDEBAR_FIELD.top + SIDEBAR_FIELD.height;

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
  if (current && current.left === anchor.left && current.top === anchor.top && current.width === anchor.width && current.sidebar?.height === anchor.sidebar?.height) return;
  useUrlAnchors.setState({ [windowId]: anchor });
}
