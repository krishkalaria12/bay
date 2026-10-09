import type { SplitSide } from "../../store/splits";
import { SPLIT_PREVIEW, ZONE_LEAN, ZONE_STAGES } from "./constants";
import type { Rect } from "./geometry";

export type ZoneStage = keyof typeof ZONE_STAGES;
export function zoneRect(pane: Rect, side: SplitSide, stage: ZoneStage, pointerX = 0): Rect {
  const s = ZONE_STAGES[stage];
  const width = pane.width * s.width;
  const height = pane.height * s.height;
  const inset = pane.width * s.inset;
  const y = pane.y + (pane.height - height) / 2;
  if (stage !== "active") return { x: side === "left" ? pane.x + inset : pane.x + pane.width - inset - width, y, width, height };
  const home = zoneRect(pane, side, "grown");
  const centre = home.x + home.width / 2;
  const lean = centre + (pointerX - centre) * ZONE_LEAN;
  const x = Math.max(pane.x + inset, Math.min(pane.x + pane.width - inset - width, lean - width / 2));
  return { x, y, width, height };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// The target under the dragged card (pointer `px`, `py` in the panes' coordinates). The current target keeps
// its larger, leaning shape while the card still touches it, so it doesn't flicker as it grows.
export function zoneHit(panes: [string, Rect][], px: number, py: number, current: { tabId: string; side: SplitSide } | null) {
  const card = { x: px - SPLIT_PREVIEW.width / 2, y: py - SPLIT_PREVIEW.height / 2, width: SPLIT_PREVIEW.width, height: SPLIT_PREVIEW.height };
  let best: { tabId: string; side: SplitSide; distance: number } | null = null;
  for (const [tabId, pane] of panes) {
    for (const side of ["left", "right"] as const) {
      const keep = current?.tabId === tabId && current.side === side;
      const r = zoneRect(pane, side, keep ? "active" : "grown", px);
      if (!overlaps(card, r)) continue;
      const distance = keep ? -1 : Math.abs(r.x + r.width / 2 - px);
      if (!best || distance < best.distance) best = { tabId, side, distance };
    }
  }
  return best && { tabId: best.tabId, side: best.side };
}
