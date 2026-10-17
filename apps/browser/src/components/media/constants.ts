// Media's constants: the players' metrics, screen sharing and casting, and Now Playing's artwork.

// MARK: Players (MiniPlayer.tsx, SidebarPlayer.tsx, Marquee.tsx)

export const MINI_PLAYER_WIDTH = 320;
export const MINI_PLAYER_HEIGHT = 76;
export const MINI_PLAYER_INSET = 10;
export const MINI_PLAYER_ART = 56;
export const MINI_PLAYER_TEXT_X = MINI_PLAYER_INSET + MINI_PLAYER_ART + 12;
export const MINI_PLAYER_CONTROLS_WIDTH = 88;
export const SEEK_HOVER_SEGMENTS = 40;
export const SIDEBAR_PLAYER_HEIGHT = 74 + 8;
export const SKIP_SECONDS = 15;

export const MARQUEE_SPEED = 30;
export const MARQUEE_PAUSE_MS = 1500;
export const MARQUEE_FADE = 12;
export const MARQUEE_FADE_STEPS = 8;

// MARK: Sharing and casting (ShareBar.tsx, SharePicker.tsx, CastPicker.tsx)

export const SHARE_BAR_HEIGHT = 38;
// A share ends when its capture does. "Share this tab instead" stops the old source before it starts the new one, so the
// capture goes off for a moment: a share is forgotten only once it stays off.
export const SHARE_END_MS = 1500;
export const SHARE_PICKER_WIDTH = 460;
export const SHARE_SOURCES_REFRESH_MS = 2500;
export const CAST_PICKER_WIDTH = 340;

// MARK: Artwork (artwork.ts)

export const ARTWORK_MAX_PIXELS = 256;
export const ARTWORK_CACHE_ENTRIES = 24;
