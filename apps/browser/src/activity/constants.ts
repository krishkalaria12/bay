import type { LiveFolderKind } from "./types";

// Live folders' constants: how often they refresh, how much they keep, and the services they ask.

// MARK: Refreshing (engine.ts)

export const REFRESH_INTERVAL_MS: Record<LiveFolderKind, number> = { pullRequests: 3 * 60_000, documents: 10 * 60_000 };
export const STALE_ON_FOCUS_MS = 60_000;
export const COMPLETION_MS = 2600;

// MARK: Store (store.ts, rows.ts)

export const LIVE_DOC = "live.json";
export const MAX_KNOWN_ITEMS = 600;
export const MAX_COMPLETED_ITEMS = 20;
export const LIVE_PAGE_SIZE = 8;

// MARK: Calendar and meetings (calendar.ts, meetings.ts, meetingGroups.ts)

export const CALENDAR_HORIZON_MS = 36 * 3_600_000;
export const MEETING_FALLBACK_TITLE = "Meeting";
export const MEETING_CLEANUP_IDLE_MS = 30 * 60_000;
// Dia: 5 / 2 min.
export const WIGGLE_MARKS_MIN = [5, 2];

// MARK: Services (github.ts, googleAuth.ts)

export const DETAILS_PAGE = 10;
export const GOOGLE_REDIRECT = "http://127.0.0.1:53682/bay-oauth";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
