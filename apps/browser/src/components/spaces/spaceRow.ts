import { DOTS_CELL, SPACE_CELL, SPACE_GAP } from "./constants";

// The sidebar's row of spaces (SpaceSwitcher.tsx): an icon each while they all fit; past that, the current space and
// its neighbours keep their icons and the others are dots, so the row says where you are and what's either side.

/** The most icons kept among dots: the current space and one either side. */
export const NEAR_ICONS = 3;

/** An icon's slot, its share of the gap between icons included. */
export const ICON_SLOT = SPACE_CELL + SPACE_GAP;

/**
 * Which of `count` spaces show their icon in a row `room` points wide: all of them when they fit; otherwise as many as
 * fit beside the dots (at most NEAR_ICONS) around the current one (`current`, -1 for none), held inside the row at
 * either end.
 */
export function iconWindow(count: number, current: number, room: number): boolean[] {
  if (count * ICON_SLOT - SPACE_GAP <= room) return Array.from({ length: count }, () => true);

  if (current < 0) return Array.from({ length: count }, () => false);
  const fit = Math.floor((room - count * DOTS_CELL) / (ICON_SLOT - DOTS_CELL));
  const icons = Math.max(1, Math.min(NEAR_ICONS, fit, count));
  const start = Math.max(0, Math.min(count - icons, current - Math.floor((icons - 1) / 2)));

  return Array.from({ length: count }, (_, i) => i >= start && i < start + icons);
}

/** The row's cell widths. */
export const cellWidths = (icons: boolean[]): number[] => icons.map((icon) => (icon ? ICON_SLOT : DOTS_CELL));

/** Where each cell's centre is along a row of these widths. */
export function centres(widths: number[]): number[] {
  let x = 0;

  return widths.map((w) => {
    const centre = x + w / 2;
    x += w;

    return centre;
  });
}
