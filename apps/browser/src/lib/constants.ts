// The app's own constants: what every part of it shares (its name, its metrics), then each service's (lib/*) timings,
// limits and files. Plain values only, so anything can import them, the tests' plain Node included.

// MARK: App

export const APP_NAME = "Bay";
export const AUTO_CLEAN_EVERY_MS = 30 * 60 * 1000;

// For codes, keys and paths.
export const MONO_FONT = "Menlo";

// A custom icon that's an SF Symbol rather than an emoji: "symbol:<name>" (tabs, groups and profiles).
export const SYMBOL_PREFIX = "symbol:";

// The window's metrics: the sidebar, its rows, the page card and its toolbar.
export const layout = {
  // Wide enough that the header shows the sidebar toggle beside the window buttons (sidebar/AddressBar.tsx).
  sidebarWidth: 228,
  sidebarHeader: 46,
  // Dia: 6pt inset.
  sidebarInset: 6,
  // Dia: 41pt tiles, 6pt gap, 54pt top.
  pinnedTop: 54,
  pinnedHeight: 41,
  // Arc: 36pt column rows with 16pt icons.
  rowHeight: 36,
  rowGap: 2,
  cardTop: 6,
  cardInset: 7,
  cardRadius: 10,
  toolbarHeight: 41,
  toolbarButton: 30,
  toolbarIconCenters: [21, 56, 92, 127],
  breadcrumbX: 153,
  trafficLightsWidth: 78,
} as const;

// MARK: Persistence (persist.ts)

export const SAVE_DELAY_MS = 800;
export const PERSIST_VERSION = 2;

// MARK: Bookmarks (bookmarks.ts)

export const LEGACY_BOOKMARKS_FILE = "bookmarks.json";
// Chrome saves its bookmarks file a moment after a change; the old file stays until then, so a crash before it
// moves it again (adding only what Chrome lacks).
export const LEGACY_BOOKMARKS_KEPT_MS = 10_000;
// The tree as last read from Chrome, shown at launch until Chrome has loaded its own (no empty bar). Display only:
// it's never sent to Chrome, and what the app does before the read is replayed on Chrome's tree.
export const BOOKMARKS_CACHE_FILE = "bookmarks-cache.json";
export const BOOKMARKS_CACHE_SAVE_MS = 2000;

// MARK: History (history.ts)

export const LEGACY_HISTORY_FILE = "history.json";
// Chrome recorded the same visits the old file did, a moment apart (it notes a visit at commit, the app did at
// load end): within this, a saved visit is one Chrome has.
export const LEGACY_HISTORY_TOLERANCE_MS = 60_000;
// Chrome expires visits older than this; there's no use adding them.
export const CHROME_HISTORY_KEEPS_MS = 90 * 86_400_000;
export const HISTORY_CHUNK = 500;
// Chrome commits history a few seconds after a change; the old file stays until then, so a crash before it moves
// it again (adding only what Chrome lacks).
export const LEGACY_HISTORY_KEPT_MS = 15_000;

// MARK: Favicons (favicons.ts)

export const APPEARANCE_SWAP_MS = 5000;
export const MAX_FAVICONS = 3000;
export const FAVICON_LOOKUP_DELAY_MS = 16;
// Per engine call (nn_favicons_get answers up to 500).
export const FAVICON_LOOKUP_BATCH = 200;
export const FAVICON_FLUSH_MS = 16;

// MARK: Tabs (tabLifecycle.ts, tabPictures.ts, windowClose.ts)

// On the slow timers' grid (slowTimers.ts); the policies it applies are measured in minutes.
export const LIFECYCLE_SWEEP_MS = 30_000;
export const LIFECYCLE_EVAL_TIMEOUT_MS = 2_000;
export const PICTURE_SETTLE_MS = 1500;
export const MAX_TAB_PICTURES = 40;
// Closing a window with this many tabs asks first (Settings › Warn before closing a window with multiple tabs).
export const CLOSE_WARNING_MIN_TABS = 2;

// MARK: Profiles (profileData.ts)

// How long a deleted profile's web views get to close before its engine data goes.
export const PROFILE_CLOSE_DELAY_MS = 1500;

// MARK: Notifications (webNotifications.ts)

export const NOTIFICATION_ICON_PIXELS = 128;
export const NOTIFICATION_ICON_TIMEOUT_MS = 3000;

// MARK: Space themes (spaceTheme.ts, windowTint.ts)

// The theme editor's colour field (assets/theme-spectrum.png, drawn with the same mapping): hue left to right,
// light pastel at the top to deep at the bottom, at one saturation.
export const SATURATION = 0.72;
export const TOP_LIGHTNESS = 0.82;
export const BOTTOM_LIGHTNESS = 0.34;
export const MAX_THEME_COLORS = 3;
export const DEFAULT_INTENSITY = 0.5;
export const DEFAULT_GRAIN = 0.3;
// Dia: 0.25.
export const TINT_LIGHTNESS = 0.25;
export const INACTIVE_FILL = { dark: [40.7, 33.1, 31.8], light: [235, 231, 230] };
// A solid window's grey before its space's colour: yab's sidebar (#1E1E21) in dark, a light one to match.
export const SOLID_FILL = { dark: [30, 30, 33], light: [235, 235, 237] };

// MARK: Default browser check-in (defaultBrowserCheckIn.ts)

export const CHECK_IN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECK_IN_COPY = { title: `How are you liking ${APP_NAME}?`, action: "Leave us feedback" } as const;
