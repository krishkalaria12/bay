// Sync's constants: its files, its cycle, and how much of each kind of data it carries.

// MARK: Engine (engine.ts)

export const SYNC_DOC = "sync.json";
export const SYNC_STATE_FILE = "sync-state.nns";
export const SYNC_JOURNAL_FILE = "sync-journal.nns";
export const APP_SCOPE = "app";
export const SYNC_CYCLE_MS = 15_000;
export const SYNC_AFTER_EDIT_MS = 3_000;

// MARK: Adapters (adapters.ts)

export const HISTORY_WINDOW_MS = 90 * 86_400_000;
// Chrome stores visit times in microseconds and reports them in whole ms: the same visit reads back within this.
export const SAME_VISIT_MS = 1;
export const MAX_DEVICE_TABS = 30;
export const PASSWORD_READ_INTERVAL_MS = 30_000;
