// Settings' constants: the window, and its panes' rows and timings.

// MARK: Window (SettingsWindow.tsx)

// The title row the traffic lights sit in, then the row of tabs under it.
export const SETTINGS_TITLE_HEIGHT = 28;
export const SETTINGS_TAB_BAR_HEIGHT = 58;
export const SETTINGS_TAB_MIN_WIDTH = 62;

// MARK: Panes

export const PROFILE_ROW_HEIGHT = 46;
// How long unused tabs stay before they're cleaned up (Arc's archive times).
export const CLEAN_UP_CHOICES = [
  { value: "12", title: "12 hours" },
  { value: "24", title: "24 hours" },
  { value: "168", title: "7 days" },
  { value: "720", title: "30 days" },
];
// A space's icon grid, shown under its Icon row.
export const SPACE_PANE_ICON_COLUMNS = 12;
export const APP_ICON_CHOICE_SIZE = 56;
// How long the passwords stay unlocked once macOS has let them be shown.
export const PASSWORDS_UNLOCK_MS = 5 * 60_000;
// A sync recovery phrase's length.
export const RECOVERY_WORDS = 24;
