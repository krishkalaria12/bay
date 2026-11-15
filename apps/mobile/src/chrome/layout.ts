// Layout and motion rules for the phone's chrome, ported from Cra's iPhone app (CraCore/Mobile, MIT licence, notice in
// Settings → About). Cra measured them from Arc Search's footage on an iPhone 15 Pro (393 × 852 pt). Everything here is
// plain arithmetic with no React Native in it, so tests/layout.test.ts runs it under Node and both apps share it.

/** The search sheet that rises with the keyboard (U4). */
export const searchSheet = {
  /** Sheet top to the search field. */
  topInset: 16,
  fieldHeight: 48,
  /** Field bottom to the first row. */
  rowsTopGap: 6,
  rowHeight: 56,
  /** Four rows show, and the sheet keeps room for them while the field is empty, so it never jumps while typing. */
  visibleRows: 4,
  /** Last row to the keyboard. */
  bottomInset: 8,
  /** The sheet's top corners. */
  cornerRadius: 38,
} as const;

/** The sheet's height above the keyboard with `rows` rows in view (302 pt with four). */
export function searchSheetHeight(rows: number = searchSheet.visibleRows): number {
  return searchSheet.topInset + searchSheet.fieldHeight + searchSheet.rowsTopGap + rows * searchSheet.rowHeight + searchSheet.bottomInset;
}

/** How many rows fit between the keyboard and the status bar: four in portrait, fewer in landscape. The field always stays. */
export function searchSheetRows(screenHeight: number, keyboardHeight: number, safeTop: number): number {
  const room = screenHeight - keyboardHeight - safeTop - searchSheetHeight(0);

  if (room <= 0) return 0;

  return Math.min(searchSheet.visibleRows, Math.floor(room / searchSheet.rowHeight));
}

/** The page behind the search sheet: a card 10 pt in from each side, its top under the status bar, dimmed. */
export const pageBehindSearch = { sideInset: 10, cornerRadius: 12, dim: 0.2 } as const;

/** How the page is moved behind the search sheet. */
export interface PageTransform {
  scale: number;
  shiftDown: number;
}

/** The scale and downward shift that put the page there. */
export function pageBehindSearchTransform(width: number, height: number, safeTop: number): PageTransform {
  if (width <= 0) return { scale: 1, shiftDown: 0 };

  const scale = (width - 2 * pageBehindSearch.sideInset) / width;

  return { scale, shiftDown: safeTop - (height * (1 - scale)) / 2 };
}

/** The page menu (U3): an address capsule, four tiles filling the width, rows, and the blocking footer. */
export const pageMenu = {
  /** Sheet top to the address capsule, and the capsule's and rows' distance from each side. */
  inset: 16,
  capsuleHeight: 47,
  /** Capsule to tiles. */
  tilesGap: 17,
  tileSideInset: 18,
  tileSpacing: 20,
  tileHeight: 88,
  tileCornerRadius: 22,
  /** Tiles to the first row. */
  rowsGap: 24,
  rowHeight: 48,
  rowCornerRadius: 14,
  /** Between groups of rows and the footer. */
  groupGap: 16,
  footerHeight: 56,
} as const;

/** A tile's width in a sheet `width` wide, four to a row. */
export function pageMenuTileWidth(width: number): number {
  return (width - 2 * pageMenu.tileSideInset - 3 * pageMenu.tileSpacing) / 4;
}

/** The tiles' left edges in a sheet `width` wide: four fill it; fewer keep the same spacing, centred. */
export function pageMenuTileLefts(count: number, width: number): number[] {
  if (count <= 0) return [];

  const tile = pageMenuTileWidth(width);
  const span = count * tile + (count - 1) * pageMenu.tileSpacing;
  const start = (width - span) / 2;

  return Array.from({ length: count }, (_, index) => start + index * (tile + pageMenu.tileSpacing));
}

/** Page zoom steps by ten percent between `min` and `max`. */
export function zoomStep(current: number, up: boolean, min = 50, max = 300): number {
  const next = Math.round(current / 10) * 10 + (up ? 10 : -10);

  return Math.min(max, Math.max(min, next));
}

/** The tab switcher's row (U5). */
export const tabCarousel = {
  /** How dark a card behind the one in front gets. */
  maximumDim: 0.16,
  /** The smallest a card behind gets, and the largest a card still to come gets. */
  minimumScale: 0.9,
  maximumScale: 1.02,
} as const;

/** A card's size against the one in front, and how dark it is. */
export interface CardLook {
  scale: number;
  dim: number;
}

/** How a card `relative` places right of the one in front looks (negative: behind it; fractions while scrolling). */
export function tabCardLook(relative: number): CardLook {
  if (relative >= 0) return { scale: Math.min(tabCarousel.maximumScale, 1 + 0.0096 * relative), dim: 0 };

  return { scale: Math.max(tabCarousel.minimumScale, 1 + 0.023 * relative), dim: Math.min(tabCarousel.maximumDim, -relative * tabCarousel.maximumDim) };
}

/** Whether a card dragged up by `translation` points (negative: up) at `velocity` points a second is thrown away. */
export function tabCardCloses(translation: number, velocity: number): boolean {
  "worklet";

  return translation < -120 || (translation < -30 && velocity < -700);
}

/** A spring by how long one period takes and how damped it is; 1 is critically damped (no overshoot). Unit mass. */
export interface Spring {
  response: number;
  dampingRatio: number;
}

/** A spring as Reanimated takes it. */
export interface SpringPhysics {
  stiffness: number;
  damping: number;
  mass: number;
}

/** The spring as Reanimated's physical configuration. */
export function springConfig(spring: Spring): SpringPhysics {
  return { stiffness: ((2 * Math.PI) / spring.response) ** 2, damping: (4 * Math.PI * spring.dampingRatio) / spring.response, mass: 1 };
}

/** How far from rest a critically damped spring still is after `time` seconds, as a share of where it began. */
export function springRemaining(spring: Spring, time: number): number {
  const omega = (2 * Math.PI) / spring.response;

  return (1 + omega * time) * Math.exp(-omega * time);
}

/** Things settling where a finger left them: the tab row, a sheet, a card going back. Fitted to Arc Search: 0.34 s, no overshoot. */
export const settleSpring: Spring = { response: 0.34, dampingRatio: 1 };

/** A card growing into its page: there within five frames. */
export const openSpring: Spring = { response: 0.26, dampingRatio: 1 };

/** The page under a finger dragging the bar up: 0 is the whole page, 1 its card in the switcher; a 300 pt drag gets there. */
export function switcherProgress(dragUp: number): number {
  "worklet";

  return Math.min(1, Math.max(0, dragUp / 300));
}

/** Whether letting go of that drag opens the switcher: far enough, or flicked upwards. */
export function opensSwitcher(dragUp: number, velocityUp: number): boolean {
  "worklet";

  return dragUp > 110 || (dragUp > 20 && velocityUp > 500);
}

/** What a sideways swipe across a page decides when the finger lifts (C5, C6). */
export const swipe = {
  /** A drag commits once it has gone this share of the width… */
  commitFraction: 0.35,
  /** …or is moving this fast after at least `flickDistance`. */
  flickVelocity: 500,
  flickDistance: 30,
  /** From the edges only: a swipe has to start this close to a side. */
  edgeWidth: 24,
} as const;

/** -1 for a committed drag to the left, 1 to the right, 0 when it falls back. */
export function swipeDirection(translation: number, velocity: number, width: number): -1 | 0 | 1 {
  "worklet";

  const far = Math.abs(translation) > width * swipe.commitFraction;
  const flicked = Math.abs(translation) > swipe.flickDistance && Math.abs(velocity) > swipe.flickVelocity && translation * velocity > 0;

  if (!far && !flicked) return 0;

  return translation > 0 ? 1 : -1;
}

export type SwipeNavigation = "none" | "back" | "forward" | "archiveTab" | "reopenTab";

/**
 * A swipe across the page: right is back, left is forward. Back on a tab's first page archives the tab and shows the
 * one before it; forward with nowhere to go, right after that, brings the archived tab back.
 */
export function swipeNavigation(
  direction: -1 | 0 | 1,
  state: { canGoBack: boolean; canGoForward: boolean; hasOtherTab: boolean; canReopenTab: boolean },
): SwipeNavigation {
  "worklet";

  if (direction === 1) return state.canGoBack ? "back" : state.hasOtherTab ? "archiveTab" : "none";

  if (direction === -1) return state.canGoForward ? "forward" : state.canReopenTab ? "reopenTab" : "none";

  return "none";
}

export type SwipeToNavigate = "anywhere" | "edges" | "off";

/** Whether a swipe across a page `width` wide may start at `x`. */
export function swipeMayStart(x: number, width: number, mode: SwipeToNavigate): boolean {
  "worklet";

  if (mode === "off") return false;

  return mode === "anywhere" || x < swipe.edgeWidth || x > width - swipe.edgeWidth;
}
