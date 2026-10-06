import { create } from "zustand";
import { layout } from "../../lib/theme";
import { useBrowser, type BrowserState } from "../../store/browser";
import { useWindowId } from "../../store/hooks";

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

export const SIDEBAR_FIELD = { top: 48, height: layout.rowHeight, radius: 10 } as const;
// Dia: 34pt button, 41pt footer, 28pt band, 3pt inset.
export const SIDEBAR_FOOTER_DOWNLOADS = { bottom: 3 + (28 - 34) / 2, size: 34 } as const;
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
