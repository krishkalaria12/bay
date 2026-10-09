import type { HistoryEntry } from "./types";

// The store's constants: the default profile's id, and how much each slice keeps.

export const DEFAULT_PROFILE_ID = "default";

// MARK: History

// The fallback for a profile with no history yet: one array, so selectors that fall back on it return the same one.
export const NO_HISTORY: HistoryEntry[] = [];
export const MAX_HISTORY = 5000;
export const MAX_VISIT_TIMES = 50;

// MARK: Closed tabs, windows and groups

export const MAX_CLOSED_TABS = 50;
export const MAX_CLOSED_WINDOWS = 10;
export const MAX_CLOSED_GROUPS = 20;

// MARK: Cleaning up (organize.ts)

export const CLEAN_UP_AFTER_MS = 12 * 60 * 60 * 1000;
export const MAX_CLEANED = 100;
export const DELETED_GROUP_MS = 7 * 86_400_000;

// MARK: Splits and downloads

export const MAX_SPLIT_PANES = 3;
export const MAX_DOWNLOADS = 100;
