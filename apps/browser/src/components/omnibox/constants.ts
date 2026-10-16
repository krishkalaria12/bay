// The command bar's constants: where the command panel opens, and the palette's metrics (the downloads panel is a
// palette too, and shares them).

// MARK: Command panel (CommandPanel.tsx)

// Dia: 37.4pt offset, 5.5pt rise, 888pt max, 12pt margin/radius.
export const PANEL_LEFT_OF_URL = 37.4;
export const PANEL_ABOVE_PANE = 5.5;
export const PANEL_MAX_WIDTH = 888;
export const PANEL_MIN_WIDTH = 420;
export const PANEL_WINDOW_MARGIN = 12;
export const DROPDOWN_MIN_WIDTH = 350;
export const DROPDOWN_PAST_FIELD = 137;
export const DROPDOWN_RADIUS = 12;

// MARK: Palette (PaletteContent.tsx)

export const PALETTE_FIELD_HEIGHT = 58;
export const PALETTE_FOOTER_HEIGHT = 44;
export const PALETTE_ROW_HEIGHT = 38;
export const CALCULATION_ROW_HEIGHT = 72;
export const CURRENCY_ROW_HEIGHT = 90;
export const calculationRowHeight = (answer: { detail?: string }) => (answer.detail ? CURRENCY_ROW_HEIGHT : CALCULATION_ROW_HEIGHT);
// As yab's: one height whatever it lists (room for about nine rows), the list scrolling inside, so the palette
// neither grows nor moves as you type.
export const PALETTE_HEIGHT = 470;
export const PALETTE_LIST_TOP = 6;
// A section's title over its rows (Recent Tabs, Frequent), as yab labels them.
export const PALETTE_TITLE_HEIGHT = 26;

// MARK: Downloads panel (DownloadsPanel.tsx)

export const DOWNLOADS_ROW_HEIGHT = 44;
export const DOWNLOADS_LIST_TOP = 4;

// MARK: Suggestions (dropdownStart.ts, useSuggestions.ts)

export const DROPDOWN_RECENT_PAGES = 4;
export const SUGGEST_WARM_SLICE_MS = 4;
