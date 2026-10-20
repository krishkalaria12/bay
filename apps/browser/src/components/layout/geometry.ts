import { capabilities } from "@bay/platform";
import { layout } from "../../lib/constants";
import { slotsOf } from "../../store/splits";
import type { SplitView } from "../../store/types";
import { MIN_PANE, PANE_GAP, SIDEBAR_BUTTON_END_ROOM, TRAFFIC_LIGHTS_OFFSET } from "./constants";
import { CAPTION_BUTTONS_WIDTH } from "./windowButtons";

export type Rect = { x: number; y: number; width: number; height: number };

export type Divider = { kind: "root"; index: number; rect: Rect; vertical: boolean } | { kind: "stack"; rect: Rect; vertical: boolean };

export type SplitGeometry = { panes: Record<string, Rect>; dividers: Divider[] };

function cut(total: number, sizes: number[], gap: number): { start: number; size: number }[] {
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

export function resize(sizes: number[], a: number, delta: number, total: number, gap = PANE_GAP): number[] {
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
  // The window's caption buttons over the toolbar's end (Windows): the pane at the window's top right.
  captionEnd: boolean;
  back: number;
  forward: number;
  reload: number;
  urlLeft: number;
};

const geometries = new Map<string, ToolbarGeometry>();

// One object per layout, so panes that get it as a prop can skip re-rendering.
type ToolbarLayout = { sidebarButton: boolean; clearTrafficLights: boolean; sidebarButtonEnd?: boolean; captionEnd?: boolean };

export function toolbarGeometry(o: ToolbarLayout): ToolbarGeometry {
  const key = `${o.sidebarButton}|${o.clearTrafficLights}|${!!o.sidebarButtonEnd}|${!!o.captionEnd}`;
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = computeToolbarGeometry(o)));
  return g;
}

function computeToolbarGeometry(o: ToolbarLayout): ToolbarGeometry {
  const offset = o.clearTrafficLights ? TRAFFIC_LIGHTS_OFFSET : 0;
  const end = !!o.sidebarButtonEnd;
  const captionEnd = !!o.captionEnd;
  const [c0, c1, c2, c3] = layout.toolbarIconCenters;
  if (o.sidebarButton)
    return {
      sidebarButton: offset + c0,
      sidebarButtonEnd: end,
      captionEnd,
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
    back: offset + c1 - shift,
    forward: offset + c2 - shift,
    reload: offset + c3 - shift,
    urlLeft: offset + layout.breadcrumbX - 8 - shift,
  };
}

// The caption buttons' room at the toolbar's right: theirs at the window's corner, less the card's inset.
export const CAPTION_END_ROOM = Math.max(0, CAPTION_BUTTONS_WIDTH - layout.cardInset);
/** What a toolbar's end keeps clear: the caption buttons outermost, then a sidebar toggle there. */
export const toolbarEndRoom = (g: ToolbarGeometry) => (g.captionEnd ? CAPTION_END_ROOM : 0) + (g.sidebarButtonEnd ? SIDEBAR_BUTTON_END_ROOM : 0);

export const NO_TOOLBAR: ToolbarGeometry = { sidebarButton: null, sidebarButtonEnd: false, captionEnd: false, back: 21, forward: 21, reload: 21, urlLeft: 8 };
// No toolbar on the window's top-left pane with the sidebar on the right: the window buttons show over its corner on
// hover, so what starts there (Developer Mode's bar, prompts) starts past them.
export const NO_TOOLBAR_PAST_LIGHTS: ToolbarGeometry = capabilities.trafficLights ? { ...NO_TOOLBAR, urlLeft: TRAFFIC_LIGHTS_OFFSET } : NO_TOOLBAR;
