import { capabilities } from "@bay/platform";
import type { BrowserWindow, ClosedWindow, Frame, WindowPlacement, WindowSize } from "./types";

export function validWindowSize(value: unknown): value is WindowSize {
  return Array.isArray(value) && value.length === 2 && Array.from(value).every((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1_000_000);
}

/** Size is additive in v2. An older frame can supply dimensions, never a Wayland position. */
export function restoredWindowPlacement(value: { frame?: Readonly<Frame> | null; size?: Readonly<WindowSize>; maximized?: boolean }): WindowPlacement {
  const size = validWindowSize(value.size) ? value.size : Array.isArray(value.frame) && value.frame.length === 4 ? value.frame.slice(2) : undefined;
  return {
    ...(validWindowSize(size) ? { size: [...size] as WindowSize } : {}),
    ...(typeof value.maximized === "boolean" ? { maximized: value.maximized } : {}),
  };
}

/** Explicit fields keep legacy XY, fullscreen, minimized and unknown placement keys off disk. */
export function restorableWindow(w: BrowserWindow & { tabIds?: string[] }): BrowserWindow {
  if (capabilities.globalWindowCoordinates) return w;
  return {
    id: w.id,
    spaceId: w.spaceId,
    incognito: w.incognito,
    activeTabIds: w.activeTabIds,
    // Pre-space-list v2 sessions still use this ordering during hydration.
    ...(Array.isArray(w.tabIds) ? { tabIds: w.tabIds.filter((id) => typeof id === "string") } : {}),
    sidebarOpen: w.sidebarOpen,
    ...(w.tabLayout === "sidebar" || w.tabLayout === "top" ? { tabLayout: w.tabLayout } : {}),
    frame: null,
    ...restoredWindowPlacement(w),
    createdAt: w.createdAt,
    ...(w.kind === "small" ? { kind: w.kind } : {}),
  };
}

export function restorableClosedWindow(w: ClosedWindow["window"]): ClosedWindow["window"] {
  if (capabilities.globalWindowCoordinates) return w;
  return {
    spaceId: w.spaceId,
    sidebarOpen: w.sidebarOpen,
    frame: null,
    ...restoredWindowPlacement(w),
    ...(typeof w.shownTabId === "string" ? { shownTabId: w.shownTabId } : {}),
  };
}

export function restorableClosedEntry(c: ClosedWindow): ClosedWindow {
  return { ...c, window: restorableClosedWindow(c.window) };
}

/** Only supported placement fields reach openWindow, in either authority mode. */
export function nativeWindowPlacement(w: BrowserWindow): { frame?: Frame | null } & WindowPlacement {
  if (!capabilities.globalWindowCoordinates) return restoredWindowPlacement(w);
  return { frame: w.frame, ...(!w.frame ? restoredWindowPlacement(w) : {}) };
}
