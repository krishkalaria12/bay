import { capabilities } from "@bay/platform";
import { layout } from "../../lib/constants";
import { bouncySpring } from "../../lib/springs";

// The window layout's constants: the page card's toolbar and panes, the sidebar's place in the window, switches,
// splits and swipes, and the top tab strip.

// MARK: Toolbar and panes (geometry.ts)

export const PANE_GAP = 7;
export const MIN_PANE = 220;
// The traffic lights' room in a toolbar; none where the platform has none (Windows draws caption buttons).
export const TRAFFIC_LIGHTS_OFFSET = capabilities.trafficLights ? 70 : 0;
// The toolbar's buttons and field centre on this line.
export const TOOLBAR_BUTTON_MID = 21.2;
export const TOOLBAR_BUTTON_TOP = TOOLBAR_BUTTON_MID - layout.toolbarButton / 2;
// The end toggle's room at the toolbar's right: its button and a 2pt gap.
export const SIDEBAR_BUTTON_END_ROOM = layout.toolbarButton + 2;

// MARK: The sidebar's field and footer (windowLayout.ts)

// yab: a 32pt field.
export const SIDEBAR_FIELD = { top: 48, height: 32, radius: 10 } as const;
// The space switcher's + mirrored: a 28pt button centred on the 41pt footer's band (3pt short of its bottom).
export const SIDEBAR_FOOTER_DOWNLOADS = { bottom: 3 + (41 - 3 - 28) / 2, size: 28 } as const;
export const SIDEBAR_HEADER_WITH_FIELD = SIDEBAR_FIELD.top + SIDEBAR_FIELD.height;

// MARK: The toolbar that hides while scrolling (toolbarAutoHide.ts, AutoHideToolbar.tsx)

// The collapsed strip's height; the page gets the rest of the toolbar's back.
export const AUTO_HIDE_STRIP_HEIGHT = 20;
// Dia (owner's clip, 60 fps): the page's top glides up over ~150 ms, eased out (17, 32, 49, 68, 76, 88, 93, 95,
// 100 % per frame); the controls are gone in ~5 frames (45, 25, 11, 3 % left). Showing mirrors it, a little longer and
// softer at the end so the page settles rather than snaps, the controls fading and growing back in.
export const TOOLBAR_HIDE_MS = 150;
export const TOOLBAR_SHOW_MS = 200;
// Resting on the strip this long peeks the bar (crossing it on the way to the tab strip doesn't).
export const TOOLBAR_PEEK_DELAY_MS = 150;
export const TOOLBAR_UNPEEK_DELAY_MS = 250;
export const TOOLBAR_PEEK_SHRINK = 0.94;
// What the page gets back from the bar itself.
export const TOOLBAR_BAR_ROOM = layout.toolbarHeight - AUTO_HIDE_STRIP_HEIGHT;

// MARK: Peeks, resizing and popovers (usePeek.ts, useResizeDrag.ts, HistoryPopover.tsx, PageLoadGlow.tsx)

export const PEEK_SLIDE_MS = 180;
export const PEEK_HIDE_DELAY_MS = 120;
// Past its range the edge follows the pointer less and less, never more than RESIZE_BAND pt.
export const RESIZE_BAND = 36;
export const RESIZE_BAND_SCALE = 90;
export const HISTORY_POPOVER_WIDTH = 300;
// The loading pill's width, springing between the two while the page loads.
export const LOAD_GLOW_NARROW = 30;
export const LOAD_GLOW_WIDE = 64;

// MARK: Paging between spaces (spacePager.ts)

// Dia: 1pt threshold, 50ms bursts, 0.25s cooldown.
export const WHEEL_THRESHOLD = 1;
export const WHEEL_BURST_MS = 49;
export const WHEEL_COOLDOWN_MS = 250;

// MARK: Tab switches (switchMotion.ts)

// Panes and rows see a switch within a render or two; one showing a tab long after (full screen ending) isn't one.
export const SWITCH_FRESH_MS = 500;
// As yab switches pages: the page left stays on screen while the one switched to fades in over it (or it fades off
// the new one), and the new page settles a few points the way the switch went. Over in about six frames.
export const PAGE_SWITCH_MS = 120;
export const PAGE_SWITCH_OFFSET = 4;
// A pane faded off stays transparent this long after: its page hides a frame or two after the switch ends (native
// views apply their props apart from React's), and at full opacity meanwhile it flashed over the page switched to.
export const PAGE_SETTLE_MS = 250;

// MARK: Splits (splitDrop.ts, SplitChrome.tsx)

// Dia's split targets ("Add left split" / "Add right split", DragDrop.SplitTargetView), measured in the owner's
// recordings (dia-spec.md › Split targets) as fractions of the pane's card, which they're centred on vertically.
// `rest`: the targets slide in from the card's edges as the tab leaves its list; `grown`: once it's over the
// page; `active`: the target the dragged card overlaps, which also leans toward the pointer.
export const ZONE_STAGES = {
  rest: { width: 0.1324, height: 0.383, inset: 0.025 },
  grown: { width: 0.215, height: 0.611, inset: 0.02 },
  active: { width: 0.241, height: 0.69, inset: 0.02 },
} as const;
export const ZONE_LEAN = 0.43;
// The card that follows the pointer over the page, centred on it (Dia: 209 × 109.5 pt).
export const SPLIT_PREVIEW = { width: 209, height: 110 };
export const ZONE_SLIDE_MS = 110;
// Dia's targets settle in about 0.12 s with no overshoot: a 0.2 s response, 0.9 damping.
export const ZONE_SPRING = { stiffness: 987, damping: 56.5, mass: 1 } as const;
// The toast pops up on Animated's old spring (speed 18, bounciness 6).
export const SPLIT_TOAST_SPRING = bouncySpring(18, 6);

// MARK: Swipes back and forward (swipeMotion.ts, SwipeOverlay.tsx)

// Dia: 72→82pt capsule, 14pt inset, 38pt rows.
export const SWIPE_UNIT = 75;
export const CAPSULE_SIZE = 72;
export const CAPSULE_SIZE_CONFIRMED = 82;
export const CAPSULE_INSET = 14;
export const CAPSULE_ICON = 28;
export const CAPSULE_ICON_CONFIRMED = 34;
export const RUBBER_COEFFICIENT = 0.15;
export const SWIPE_LIST_ROW = 38;
export const SWIPE_LIST_WIDTH = 200;
export const SWIPE_LIST_PAD = 8;
export const SWIPE_LIST_RADIUS = 18;
export const SWIPE_LIST_IDLE_MS = 300;

// MARK: Top tab strip (TopTabStrip.tsx, stripGroups.ts, stripReorder.ts)

// Dia's top strip, from a 2x capture of 1.50.1: the card starts 42 below the window top, and everything in the
// strip (window buttons, icons, titles) centres on y 21.
export const TOP_STRIP_HEIGHT = 42;
export const TOP_CARD_INSET = 6;
export const STRIP_MID = 21;
// Hover backgrounds, the pinned group and the + button: 32 tall, 5…37.
export const STRIP_ITEM_HEIGHT = 32;
export const STRIP_ITEM_TOP = STRIP_MID - STRIP_ITEM_HEIGHT / 2;
// The selected tab rises from the card: fill from y 3 with top corners of 10 and concave 15 pt flares at its foot,
// and a 0.5 pt rim just outside it that fades out down the sides.
export const STRIP_TAB_TOP = 3;
export const STRIP_TAB_RADIUS = 10;
export const STRIP_FLARE = 15;
export const STRIP_RIM_HEIGHT = 27.5;
export const STRIP_PEEK_PAD = 7;
export const STRIP_PEEK_HEIGHT = STRIP_ITEM_HEIGHT + STRIP_PEEK_PAD * 2;
export const STRIP_PEEK_BORDER = 0.5;
// Pinned tabs share one container: 34 pt cells 2 apart, 16 pt icons.
export const STRIP_PINNED_CELL = 34;
export const STRIP_PINNED_SPACING = 2;
export const STRIP_DOCK_GAP = 4.5;
// Many tabs shrink, as Chrome's, down to a favicon's room (below STRIP_COMPACT_CHIP they show only it); the strip
// scrolls only past that.
export const STRIP_MIN_CHIP = 28;
export const STRIP_COMPACT_CHIP = 72;
export const STRIP_MAX_CHIP = 173;
export const STRIP_GAP = 4;
// A tab pulled this far below the strip leaves it for the page (Dia: its split targets came between 5.5 and 26 pt).
export const STRIP_LIFT_SLOP = 12;
export const STRIP_LIFT_MS = 150;
// The first item starts at x 86, 12 pt after the zoom button.
export const STRIP_LIGHTS_GAP = 8;
export const STRIP_LIGHTS_CENTER: [number, number] = [20.75, 20.75];
// The controls at the strip's end: the profile chip (at most STRIP_PROFILE_ROOM), then the downloads button.
export const STRIP_PROFILE_ROOM = 140;
export const STRIP_DOWNLOADS_BOX = 34;
export const STRIP_CONTROLS_GAP = 2;
// A group's container sits 8 from the pinned dock and from the next tab.
export const STRIP_GROUP_MARGIN_LEFT = 3.5;
export const STRIP_GROUP_MARGIN_RIGHT = 4;
// Chip → first member, and the room after the last member: 4.5 collapsed, divider + close button expanded.
export const STRIP_MEMBERS_INSET = 6.5;
export const STRIP_TAIL_COLLAPSED = 4.5;
export const STRIP_TAIL_EXPANDED = 30.25;
export const STRIP_TUCK_FADE_MS = 120;
// Reordering's slide (stripReorder.ts): it comes to rest within a quarter point, so a settle that has nowhere to go
// ends at once.
export const STRIP_SLIDE = { stiffness: 8100, damping: 180, mass: 1, restDisplacementThreshold: 0.25, restSpeedThreshold: 2 } as const;

// MARK: Link peeks (PeekLayer.tsx): Arc's Peek, a link's page in a card over the page it came from

// The card's room on each side of the pane: a share of its width, at least this; the buttons sit in the right one.
export const PEEK_INSET_SHARE = 0.09;
export const PEEK_INSET_MIN = 48;
export const PEEK_CARD_GAP = 8;
export const PEEK_BUTTON = 26;
export const PEEK_OPEN_MS = 240;
