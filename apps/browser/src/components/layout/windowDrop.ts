import { capabilities } from "@bay/platform";
import { browserRead } from "../../store/read";
import type { BrowserProjection } from "../../runtime/projection";
import { createWindow, moveTabsToWindow } from "../../runtime/windowActions";
import { restoredWindowPlacement } from "../../store/windowPlacement";
import type { Frame } from "../../store/types";
import { viewTabIds } from "../../store/model";

// `live`: the window's frame now, when the store's isn't (it keeps the restored frame in full screen).
export function screenPoint(s: BrowserProjection, windowId: string, x: number, y: number, live?: Frame | null): [number, number] | null {
  if (!capabilities.globalWindowCoordinates) return null;
  const frame = live ?? s.windows[windowId]?.frame;
  if (!frame) return null;
  return [frame[0] + x, frame[1] + frame[3] - y];
}

const contains = (frame: Readonly<Frame>, [px, py]: [number, number]) =>
  px >= frame[0] && px <= frame[0] + frame[2] && py >= frame[1] && py <= frame[1] + frame[3];

export function windowUnder(
  s: BrowserProjection,
  source: string,
  x: number,
  y: number,
  live?: Frame | null,
  localSize?: readonly [number, number],
): { outside: boolean; overWindow: string | null } {
  const from = s.windows[source];
  const frame = live ?? from?.frame;
  const size = localSize ?? (frame ? [frame[2], frame[3]] : from?.size);
  const outside = !!size && (x < 0 || y < 0 || x > size[0] || y > size[1]);
  const point = outside ? screenPoint(s, source, x, y, live) : null;
  if (!point || !from || from.incognito) return { outside, overWindow: null };
  const overWindow = s.ui.focusOrder.find((id) => {
    const w = s.windows[id];
    return !!w && id !== source && !w.incognito && w.kind !== "small" && !!w.frame && contains(w.frame, point);
  });
  return { outside, overWindow: overWindow ?? null };
}

// `onNewWindow`: the frame a new window gets, before it opens (the dragged tab's picture grows into it).
export async function dropTabsOutside(
  tabIds: string[],
  source: string,
  x: number,
  y: number,
  onNewWindow?: (frame: Frame) => void,
  live?: Frame | null,
): Promise<string | null> {
  const s = browserRead.getState();
  const from = s.windows[source];
  if (!from || from.incognito || !tabIds.length) return null;
  const { overWindow } = windowUnder(s, source, x, y, live);
  if (overWindow) {
    return moveTabsToWindow(tabIds, overWindow);
  }
  if (viewTabIds(s, from.id).every((id) => tabIds.includes(id))) return null;
  if (!capabilities.globalWindowCoordinates) {
    return createWindow({ spaceId: s.tabs[tabIds[0]!]?.spaceId, tabIds, size: restoredWindowPlacement(from).size ?? [1200, 800] });
  }
  const point = screenPoint(s, source, x, y, live);
  if (!point) return null;
  const [, , width, height] = from.frame ?? [0, 0, 1200, 800];
  const frame: Frame = [Math.round(point[0] - 90), Math.round(point[1] - height + 70), width, height];
  onNewWindow?.(frame);
  return createWindow({ spaceId: s.tabs[tabIds[0]!]?.spaceId, tabIds, frame });
}
