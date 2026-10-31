import { layout } from "../../lib/constants";
import { bouncySpring } from "../../lib/springs";
import type { SlideOptions } from "../layout/switchMotion";

// The sidebar's constants: its list and rows, pinned tiles, groups and live folders, its address bar, and the
// cards and panels it opens.

// MARK: Sidebar (Sidebar.tsx, tokens.ts)

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 400;
export const GLOW_ROOM = 24;
// The pin target's band between the header and the first row, with no address field there.
export const PIN_BAND = 17;
export const ROW_PITCH = layout.rowHeight + layout.rowGap;
export const NEW_TAB_GAP = 6;
export const NEW_TAB_PITCH = layout.rowHeight + NEW_TAB_GAP;
export const DOCKED_BOTTOM = 6;
// Room the docked New Tab row takes from the list, including its gap above.
export const NEW_TAB_DOCK = DOCKED_BOTTOM + NEW_TAB_PITCH;
// Rows in 2400 pt, more than the tallest sidebar.
export const FIRST_PAINT_ROWS = 64;
export const ROWS_PER_FRAME = 32;
export const CLEAN_UP_UPSELL_MIN = 10;
export const AUTO_CLEAN_EVERY_MS = 30 * 60 * 1000;

// MARK: Rows (RowMotion.tsx, ActiveHighlight.tsx, TabIcon.tsx)

// A row opening or closing (RowMotion.tsx).
export const ROW_MS = 180;
// Opening or closing more at once (restoring a window, cleaning up) just shows the list as it is.
export const MAX_MOVING_ROWS = 3;
export const ROW_FRESH_MS = 500;
export const ROW_SLIDE: SlideOptions = { offset: 6, duration: 150, axis: "y" };
export const SLEEPING_OPACITY = 0.45;

// MARK: Groups and live folders (geometry.ts, Fold.tsx, LiveFolderBlock.tsx)

export const GROUP_PAD = 2;
export const GROUP_BORDER = 0.5;
// Dia 1.50.1 (owner recording, 60 fps): a group opens or closes in about 150 ms.
export const FOLD_MS = 150;
export const LIVE_FOLDER_PAD = 2;
// The completion glyph pops in on Animated's old spring (speed 14, bounciness 14).
export const LIVE_POP_SPRING = bouncySpring(14, 14);

// MARK: Pinned rows and folders (Sidebar.tsx, FolderBlock.tsx)

// A folder's rows sit this far in from its header, under its name.
export const FOLDER_INDENT = 14;
// The line under the Pinned section, with room above and below it; a tab dropped above its middle is pinned.
export const PINNED_DIVIDER_PAD = 6;

// MARK: Pinned tiles and dragging (PinnedGrid.tsx, dnd.tsx)

export const PINNED_TILE_GAP = 6;
export const MIN_PINNED_TILE = 50;
// Dia: 3pt stroke.
export const PINNED_SELECTION_STROKE = 3;
export const PINNED_GLASS_RIM = 1;
// The back-to-pinned badge pops in and out on Animated's old spring (speed 18, bounciness 8).
export const PINNED_BADGE_SPRING = bouncySpring(18, 8);
// The marker for the window's tab scrolled out of view (OffscreenTabMarker.tsx): its height, and its gap to the edge.
export const OFFSCREEN_MARKER_HEIGHT = 20;
export const OFFSCREEN_MARKER_INSET = 4;
// A favorite's unread count (UnreadBadge.tsx): the system's notification red.
export const UNREAD_BADGE_RED = "#FF3B30";
// A drag this near the list's top or bottom scrolls it.
export const DRAG_SCROLL_EDGE = 28;

// MARK: Address bar (AddressBar.tsx)

export const ADDRESS_BUTTON = layout.toolbarButton;
export const ADDRESS_NAV_GAP = 5;
export const ADDRESS_NAV_WIDTH = 3 * ADDRESS_BUTTON + 2 * ADDRESS_NAV_GAP;
// Dia: lights y26.75pt, x70.75pt; 5pt gap, 7pt inset.
export const ADDRESS_LIGHTS_Y = 26.75;
export const ADDRESS_TOGGLE_X = 70.75 + 27;
export const ADDRESS_EDGE = 7;

// MARK: Hover card (hover.ts, HoverCard.tsx)

export const HOVER_SHOW_DELAY_MS = 650;
export const HOVER_HIDE_DELAY_MS = 160;
export const HOVER_CARD_WIDTH = 264;
export const HOVER_CARD_PAD = 10;
export const HOVER_CARD_PREVIEW_HEIGHT = 140;
export const HOVER_CARD_PEEK_ROWS = 8;

// MARK: Icon picker (IconPicker.tsx)

export const ICON_PICKER_COLUMNS = 8;
export const ICON_PICKER_CELL = 36;
export const ICON_PICKER_WIDTH = ICON_PICKER_COLUMNS * ICON_PICKER_CELL + 20;
// About as tall as it draws (switch, search, six rows and a heading, the category bar): enough to keep it on screen.
export const ICON_PICKER_HEIGHT = 390;
// A space's emoji panel (yab's): the sidebar's width, seven emoji a row.
export const SPACE_PICKER_COLUMNS = 7;
export const SPACE_PICKER_PAD = 12;
// The pickers fade in and out over this long.
export const PICKER_FADE_MS = 150;

// MARK: Search tabs and the tab switcher (SearchTabs.tsx, switcher.ts, TabSwitcher.tsx)

export const SEARCH_TABS_WIDTH = 560;
export const SEARCH_TABS_ROW = 36;
export const SEARCH_TABS_MAX_ROWS = 10;
export const SWITCHER_SHOW_AFTER_MS = 140;
export const SWITCHER_WIDTH = 400;
export const SWITCHER_ROW = 40;

// MARK: + menu (NewMenu.tsx)

// The + it rises from (its registered row), its width and how long it takes to come and go.
export const NEW_MENU_ID = "new-menu";
export const NEW_MENU_WIDTH = 230;
export const NEW_MENU_MS = 170;

// MARK: Clear (clear.ts)

// The room the divider's line leaves for Clear at its end.
export const CLEAR_WIDTH = 44;
// The room the divider leaves under its line while Clear shows (Clear's text reaches below the line).
export const CLEAR_GAP = 6;
// Under the space's title row, before its pinned tabs (or, with none, its tabs).
export const SPACE_TITLE_GAP = 6;
// The rows Clear breaks into pixels (a screenful): any more go without.
export const CLEAR_MAX_ROWS = 18;
