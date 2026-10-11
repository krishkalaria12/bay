// Profiles' and spaces' constants: the profile indicator, the sidebar footer's dots and space switcher, and the
// theme editor.

// MARK: Profile indicator (SpaceIndicator.tsx)

export const INDICATOR_PAD = 9;
export const INDICATOR_HEIGHT = 34;
export const INDICATOR_MIN_CUT_NAME = 52;
export const INDICATOR_ICON_WIDTH = 32;
export const PROFILE_INDICATOR_X = 84;

// MARK: Profile dots (SpaceDots.tsx)

// Dia: 41pt height; 12pt cell, 6pt dot, 28pt band; opacity 0.85/0.4/0.2.
export const PROFILE_DOTS_HEIGHT = 41;
export const DOTS_CELL = 12;
export const DOTS_DOT = 6;
export const DOTS_BAND = 28;
export const DOT_SELECTED_OPACITY = 0.85;
export const DOT_HOVERED_OPACITY = 0.4;
export const DOT_IDLE_OPACITY = 0.2;

// MARK: Space switcher (SpaceSwitcher.tsx)

export const SPACE_CELL = 26;
export const SPACE_GLYPH = 15;
export const SPACE_PLUS = 28;
// Room kept on each side for + (right) and the footer's downloads button (left), so the icons stay centred.
export const SPACE_SIDE = SPACE_PLUS + 4;
export const SPACE_SELECTED_OPACITY = 0.95;
export const SPACE_HOVERED_OPACITY = 0.6;
export const SPACE_IDLE_OPACITY = 0.38;

// MARK: Create a space (CreateProfile.tsx)

// The icon grid's columns: twelve fill the sheet.
export const CREATE_SPACE_ICON_COLUMNS = 12;

// MARK: Theme editor (ThemeEditor.tsx)

// Zen's gradient generator: a dotted field holding a colour wheel (unseen; its dots keep inside it), swatch pages,
// then the wave (intensity) and the dial (grain).
export const THEME_FIELD_WIDTH = 268;
export const THEME_FIELD_HEIGHT = 236;
export const THEME_EDITOR_PAD = 14;
export const THEME_DOT = 20;
export const THEME_PRIMARY_DOT = 34;
// The wheel's radius: the first colour's dot stays whole inside the field.
export const THEME_WHEEL_RADIUS = Math.min(THEME_FIELD_WIDTH, THEME_FIELD_HEIGHT) / 2 - THEME_PRIMARY_DOT / 2 - 2;
export const THEME_SWATCH = 18;
export const THEME_SWATCHES_PER_PAGE = 9;
export const THEME_WAVE_HEIGHT = 56;
// The wave's half-height at full intensity, and the length of one of its waves.
export const THEME_WAVE_AMPLITUDE = 9;
export const THEME_WAVE_PERIOD = 22;
export const THEME_DIAL = 64;
export const THEME_DIAL_STEPS = 16;

// MARK: New space (NewSpace.tsx)

// Its panel (the sidebar's width): its padding, and how long it takes to fade in.
export const NEW_SPACE_PAD = 12;
export const NEW_SPACE_FADE_MS = 170;
