import type { WindowButtonLayout } from "@bay/shell";
import { layout } from "../../lib/constants";
import { slotsOf } from "../../store/splits";
import type { DeepReadonly } from "../../runtime/projection";
type SplitView = DeepReadonly<import("../../store/types").SplitView>;
import { MIN_PANE, PANE_GAP, SIDEBAR_BUTTON_END_ROOM, TRAFFIC_LIGHTS_OFFSET } from "./constants";
import { getWindowButtonLayout, LIGHTS_WIDTH, windowButtonRoom } from "./windowButtons";

export type Rect = { x: number; y: number; width: number; height: number };

export type Divider = { kind: "root"; index: number; rect: Rect; vertical: boolean } | { kind: "stack"; rect: Rect; vertical: boolean };

export type SplitGeometry = { panes: Record<string, Rect>; dividers: Divider[] };

function cut(total: number, sizes: readonly number[], gap: number): { start: number; size: number }[] {
  const free = Math.max(0, total - gap * (sizes.length - 1));
  let at = 0;
  return sizes.map((f) => {
    const size = Math.round(free * f);
    const out = { start: at, size };
    at += size + gap;
    return out;
  });
}

export function splitGeometry(split: SplitView, width: number, height: number, gap = PANE_GAP): SplitGeometry {
  const horizontal = split.orientation === "horizontal";
  const slots = slotsOf(split);
  const sizes = split.sizes.length === slots.length ? split.sizes : slots.map(() => 1 / slots.length);
  const panes: Record<string, Rect> = {};
  const dividers: Divider[] = [];
  const main = cut(horizontal ? width : height, sizes, gap);
  slots.forEach((slot, i) => {
    const { start, size } = main[i]!;
    const slotRect: Rect = horizontal ? { x: start, y: 0, width: size, height } : { x: 0, y: start, width, height: size };
    if (slot.length === 1) panes[slot[0]!] = slotRect;
    else {
      const inner = cut(horizontal ? slotRect.height : slotRect.width, split.stack?.sizes ?? [0.5, 0.5], gap);
      slot.forEach((id, j) => {
        const { start: s, size: z } = inner[j]!;
        panes[id] = horizontal ? { ...slotRect, y: s, height: z } : { ...slotRect, x: s, width: z };
      });
      const d = inner[0]!;
      dividers.push({
        kind: "stack",
        vertical: !horizontal,
        rect: horizontal ? { x: slotRect.x, y: d.size, width: slotRect.width, height: gap } : { x: d.size, y: slotRect.y, width: gap, height: slotRect.height },
      });
    }
    if (i < slots.length - 1) {
      dividers.push({
        kind: "root",
        index: i,
        vertical: horizontal,
        rect: horizontal ? { x: start + size, y: 0, width: gap, height } : { x: 0, y: start + size, width, height: gap },
      });
    }
  });
  return { panes, dividers };
}

export function resize(sizes: readonly number[], a: number, delta: number, total: number, gap = PANE_GAP): number[] {
  const free = Math.max(1, total - gap * (sizes.length - 1));
  const px = sizes.map((f) => f * free);
  const pair = px[a]! + px[a + 1]!;
  const min = Math.min(MIN_PANE, px[a]!, px[a + 1]!);
  const left = Math.min(Math.max(px[a]! + delta, min), pair - min);
  const next = [...px];
  next[a] = left;
  next[a + 1] = pair - left;
  return next.map((p) => p / free);
}

export type ToolbarGeometry = {
  sidebarButton: number | null;
  // The sidebar toggle at the toolbar's right end instead, beside a sidebar docked on the right.
  sidebarButtonEnd: boolean;
  // The window buttons over this pane's trailing corner.
  captionEnd: boolean;
  captionRoom: number;
  back: number;
  forward: number;
  reload: number;
  urlLeft: number;
};

const geometries = new Map<string, ToolbarGeometry>();

// One object per layout, so panes that get it as a prop can skip re-rendering.
type ToolbarLayout = { sidebarButton: boolean; clearTrafficLights: boolean; sidebarButtonEnd?: boolean; captionEnd?: boolean };

export function toolbarGeometry(o: ToolbarLayout, buttons = getWindowButtonLayout()): ToolbarGeometry {
  const room = windowButtonRoom(buttons);
  const start = o.clearTrafficLights ? (LIGHTS_WIDTH ? TRAFFIC_LIGHTS_OFFSET : Math.max(0, room.left - layout.cardInset)) : 0;
  const end = o.captionEnd ? Math.max(0, room.right - layout.cardInset) : 0;
  const key = `${o.sidebarButton}|${start}|${!!o.sidebarButtonEnd}|${!!o.captionEnd}|${end}`;
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = computeToolbarGeometry(o, start, end)));
  return g;
}

function computeToolbarGeometry(o: ToolbarLayout, offset: number, captionRoom: number): ToolbarGeometry {
  const end = !!o.sidebarButtonEnd;
  const captionEnd = !!o.captionEnd;
  const [c0, c1, c2, c3] = layout.toolbarIconCenters;
  if (o.sidebarButton)
    return {
      sidebarButton: offset + c0,
      sidebarButtonEnd: end,
      captionEnd,
      captionRoom,
      back: offset + c1,
      forward: offset + c2,
      reload: offset + c3,
      urlLeft: offset + layout.breadcrumbX - 8,
    };
  const shift = c1 - c0;
  return {
    sidebarButton: null,
    sidebarButtonEnd: end,
    captionEnd,
    captionRoom,
    back: offset + c1 - shift,
    forward: offset + c2 - shift,
    reload: offset + c3 - shift,
    urlLeft: offset + layout.breadcrumbX - 8 - shift,
  };
}

/** What a toolbar's end keeps clear: window buttons outermost, then a sidebar toggle. */
export const toolbarEndRoom = (g: ToolbarGeometry) => g.captionRoom + (g.sidebarButtonEnd ? SIDEBAR_BUTTON_END_ROOM : 0);

export const NO_TOOLBAR: ToolbarGeometry = {
  sidebarButton: null,
  sidebarButtonEnd: false,
  captionEnd: false,
  captionRoom: 0,
  back: 21,
  forward: 21,
  reload: 21,
  urlLeft: 8,
};
const noToolbars = new Map<number, ToolbarGeometry>();

/** No toolbar, but developer bars and prompts must still clear the window's corners. */
export function noToolbarGeometry(clearStart: boolean, buttons = getWindowButtonLayout()): ToolbarGeometry {
  const room = windowButtonRoom(buttons);
  const start = clearStart ? (LIGHTS_WIDTH ? TRAFFIC_LIGHTS_OFFSET : Math.max(8, room.left - layout.cardInset)) : 8;
  if (start === 8) return NO_TOOLBAR;
  let g = noToolbars.get(start);
  if (!g) noToolbars.set(start, (g = { ...NO_TOOLBAR, urlLeft: start }));
  return g;
}

/** A strip or a docked sidebar holds the buttons on the window edges it occupies. */
export function paneButtonClearance(leading: boolean, trailing: boolean, tabLayout: "sidebar" | "top", sidebarOpen: boolean, sidebarRight: boolean) {
  const strip = tabLayout === "top" && sidebarOpen;
  return {
    clearTrafficLights: leading && tabLayout === "sidebar" && !strip && (!sidebarOpen || sidebarRight),
    captionEnd: trailing && !strip && (!sidebarOpen || !sidebarRight),
  };
}

/** Sidebar header room only at its outer window edge. */
export function sidebarButtonRoom(buttons: WindowButtonLayout, right: boolean) {
  const room = windowButtonRoom(buttons);
  return { left: right ? 0 : room.left, right: right ? room.right : 0 };
}
