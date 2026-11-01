import type { ArchivedTab, BrowserData, BrowserPreferences, BrowserTab, HistoryEntry, PinnedSite, TabUpdate } from "./types";

export const DEFAULT_PREFERENCES: BrowserPreferences = {
  searchEngineId: "google",
  archiveAfterDays: 7,
  blockContent: true,
  blockingPausedHosts: [],
  lockPrivateTabs: false,
};
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 1000;
const ARCHIVE_LIMIT = 200;

export function createTab(id: string, now: number, url = "", isPrivate = false): BrowserTab {
  return { id, url, title: "", favicon: null, createdAt: now, lastVisit: now, snapshot: null, ...(isPrivate ? { private: true } : {}) };
}

export function initialBrowserData(tab: BrowserTab, preferences = DEFAULT_PREFERENCES): BrowserData {
  return {
    tabs: [tab],
    activeTabId: tab.id,
    history: [],
    pinnedSites: [],
    archive: [],
    preferences: { ...preferences, blockingPausedHosts: [...preferences.blockingPausedHosts] },
  };
}

export type BrowserAction =
  | { type: "new-tab"; tab: BrowserTab; background: boolean }
  | { type: "activate-tab"; id: string; now: number }
  | { type: "update-tab"; id: string; update: TabUpdate }
  | { type: "visit"; url: string; title: string; favicon: string | null; now: number }
  | { type: "page-title"; url: string; title: string }
  | { type: "close-tab"; id: string; now: number; fallback: BrowserTab }
  | { type: "restore-tab"; id: string; restoredId: string; now: number }
  | { type: "pin-site"; tabId: string; pinId: string }
  | { type: "search-engine"; id: string }
  | { type: "archive-days"; days: number | null }
  | { type: "archive-stale"; now: number }
  | { type: "block-content"; enabled: boolean }
  | { type: "pause-blocking"; host: string; paused: boolean }
  | { type: "lock-private-tabs"; enabled: boolean };

export function reduceBrowserData(data: BrowserData, action: BrowserAction): BrowserData {
  switch (action.type) {
    case "new-tab":
      return { ...data, tabs: [...data.tabs, action.tab], activeTabId: action.background ? data.activeTabId : action.tab.id };
    case "activate-tab": {
      if (!data.tabs.some((tab) => tab.id === action.id)) return data;
      return { ...data, activeTabId: action.id, tabs: data.tabs.map((tab) => (tab.id === action.id ? { ...tab, lastVisit: action.now } : tab)) };
    }
    case "update-tab": {
      const tab = data.tabs.find((entry) => entry.id === action.id);
      if (!tab || Object.entries(action.update).every(([key, value]) => tab[key as keyof BrowserTab] === value)) return data;
      return { ...data, tabs: data.tabs.map((entry) => (entry.id === action.id ? { ...entry, ...action.update } : entry)) };
    }
    case "visit": {
      if (!isWebAddress(action.url)) return data;
      const previous = data.history.find((entry) => entry.url === action.url);
      const visit: HistoryEntry = {
        url: action.url,
        title: action.title,
        favicon: action.favicon ?? previous?.favicon ?? null,
        visits: (previous?.visits ?? 0) + 1,
        lastVisit: action.now,
      };
      return { ...data, history: [visit, ...data.history.filter((entry) => entry.url !== action.url)].slice(0, HISTORY_LIMIT) };
    }
    case "page-title": {
      // Titles often arrive after the load finishes and the visit is saved.
      const entry = data.history.find((item) => item.url === action.url);
      if (!entry || !action.title || entry.title === action.title) return data;
      return { ...data, history: data.history.map((item) => (item === entry ? { ...item, title: action.title } : item)) };
    }
    case "close-tab": {
      const index = data.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return data;
      const tab = data.tabs[index];
      const remaining = data.tabs.filter((entry) => entry.id !== action.id);
      const tabs = remaining.length ? remaining : [action.fallback];
      return {
        ...data,
        tabs,
        activeTabId: data.activeTabId === action.id ? tabs[Math.min(index, tabs.length - 1)].id : data.activeTabId,
        // Private tabs leave nothing behind.
        archive:
          tab.url && !tab.private
            ? [{ ...tab, closedAt: action.now }, ...data.archive.filter((entry) => entry.id !== tab.id)].slice(0, ARCHIVE_LIMIT)
            : data.archive,
      };
    }
    case "restore-tab": {
      const archived = data.archive.find((tab) => tab.id === action.id);
      if (!archived) return data;
      const { closedAt: _closedAt, ...tab } = archived;
      return {
        ...data,
        tabs: [...data.tabs, { ...tab, id: action.restoredId, lastVisit: action.now }],
        activeTabId: action.restoredId,
        archive: data.archive.filter((entry) => entry.id !== action.id),
      };
    }
    case "pin-site": {
      const tab = data.tabs.find((entry) => entry.id === action.tabId);
      if (!tab?.url) return data;
      const existing = data.pinnedSites.some((site) => site.url === tab.url);
      return {
        ...data,
        pinnedSites: existing
          ? data.pinnedSites.filter((site) => site.url !== tab.url)
          : [...data.pinnedSites, { id: action.pinId, url: tab.url, title: tab.title, favicon: tab.favicon }],
      };
    }
    case "search-engine":
      return action.id && action.id !== data.preferences.searchEngineId ? { ...data, preferences: { ...data.preferences, searchEngineId: action.id } } : data;
    case "archive-days":
      return [null, 1, 7, 30].includes(action.days) && action.days !== data.preferences.archiveAfterDays
        ? { ...data, preferences: { ...data.preferences, archiveAfterDays: action.days } }
        : data;
    case "block-content":
      return action.enabled === data.preferences.blockContent ? data : { ...data, preferences: { ...data.preferences, blockContent: action.enabled } };
    case "pause-blocking": {
      const host = action.host.toLowerCase().replace(/^www\./, "");
      if (!host || data.preferences.blockingPausedHosts.includes(host) === action.paused) return data;
      const blockingPausedHosts = action.paused
        ? [...data.preferences.blockingPausedHosts, host]
        : data.preferences.blockingPausedHosts.filter((entry) => entry !== host);
      return { ...data, preferences: { ...data.preferences, blockingPausedHosts } };
    }
    case "lock-private-tabs":
      return action.enabled === data.preferences.lockPrivateTabs ? data : { ...data, preferences: { ...data.preferences, lockPrivateTabs: action.enabled } };
    case "archive-stale": {
      if (data.preferences.archiveAfterDays === null) return data;
      const cutoff = action.now - data.preferences.archiveAfterDays * DAY;
      const stale = data.tabs.filter(
        (tab) => !tab.private && tab.id !== data.activeTabId && tab.url && tab.lastVisit < cutoff && !data.pinnedSites.some((pin) => pin.url === tab.url),
      );
      if (!stale.length) return data;
      const ids = new Set(stale.map((tab) => tab.id));
      return {
        ...data,
        tabs: data.tabs.filter((tab) => !ids.has(tab.id)),
        archive: [...stale.map((tab) => ({ ...tab, closedAt: action.now })), ...data.archive.filter((tab) => !ids.has(tab.id))].slice(0, ARCHIVE_LIMIT),
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isWebAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function parseTab(value: unknown): BrowserTab | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.title !== "string" ||
    !(value.url === "" || isWebAddress(value.url)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.lastVisit)
  )
    return null;
  return {
    id: value.id,
    url: value.url,
    title: value.title,
    createdAt: value.createdAt,
    lastVisit: value.lastVisit,
    favicon: typeof value.favicon === "string" ? value.favicon : null,
    snapshot: typeof value.snapshot === "string" && value.snapshot.startsWith("file://") ? value.snapshot : null,
  };
}

function uniqueBy<T>(entries: T[], key: (entry: T) => string): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const value = key(entry);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** Validate disk state and repair collection invariants before any screen consumes it. */
export function parseBrowserData(value: unknown, fallback: BrowserData): BrowserData {
  if (!isRecord(value) || value.version !== 1) throw new Error("The saved browsing state could not be read.");
  const tabs = uniqueBy(
    (Array.isArray(value.tabs) ? value.tabs : []).map(parseTab).filter((tab): tab is BrowserTab => tab !== null),
    (tab) => tab.id,
  );
  const history: HistoryEntry[] = (Array.isArray(value.history) ? value.history : []).filter(isRecord).flatMap((entry) =>
    isWebAddress(entry.url) &&
    typeof entry.title === "string" &&
    isTimestamp(entry.lastVisit) &&
    typeof entry.visits === "number" &&
    Number.isFinite(entry.visits) &&
    entry.visits > 0
      ? [
          {
            url: entry.url,
            title: entry.title,
            favicon: typeof entry.favicon === "string" ? entry.favicon : null,
            lastVisit: entry.lastVisit,
            visits: Math.floor(entry.visits),
          },
        ]
      : [],
  );
  const pinnedSites: PinnedSite[] = (Array.isArray(value.pinnedSites) ? value.pinnedSites : [])
    .filter(isRecord)
    .flatMap((entry) =>
      typeof entry.id === "string" && entry.id && isWebAddress(entry.url) && typeof entry.title === "string"
        ? [{ id: entry.id, url: entry.url, title: entry.title, favicon: typeof entry.favicon === "string" ? entry.favicon : null }]
        : [],
    );
  const archive: ArchivedTab[] = (Array.isArray(value.archive) ? value.archive : []).flatMap((entry) => {
    const tab = parseTab(entry);
    return tab?.url && isRecord(entry) && isTimestamp(entry.closedAt) ? [{ ...tab, closedAt: entry.closedAt }] : [];
  });
  const savedPreferences = isRecord(value.preferences) ? value.preferences : {};
  const preferences: BrowserPreferences = {
    searchEngineId:
      typeof savedPreferences.searchEngineId === "string" && savedPreferences.searchEngineId
        ? savedPreferences.searchEngineId
        : DEFAULT_PREFERENCES.searchEngineId,
    archiveAfterDays: [null, 1, 7, 30].includes(savedPreferences.archiveAfterDays as number | null)
      ? (savedPreferences.archiveAfterDays as number | null)
      : DEFAULT_PREFERENCES.archiveAfterDays,
    blockContent: typeof savedPreferences.blockContent === "boolean" ? savedPreferences.blockContent : DEFAULT_PREFERENCES.blockContent,
    blockingPausedHosts: Array.isArray(savedPreferences.blockingPausedHosts)
      ? [...new Set(savedPreferences.blockingPausedHosts.filter((host): host is string => typeof host === "string" && /^[a-z0-9.-]+$/.test(host)))]
      : [],
    lockPrivateTabs: savedPreferences.lockPrivateTabs === true,
  };
  return {
    tabs: tabs.length ? tabs : fallback.tabs,
    activeTabId: tabs.some((tab) => tab.id === value.activeTabId) ? (value.activeTabId as string) : (tabs[0]?.id ?? fallback.activeTabId),
    history: uniqueBy(history, (entry) => entry.url)
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, HISTORY_LIMIT),
    pinnedSites: uniqueBy(pinnedSites, (entry) => entry.url),
    archive: uniqueBy(archive, (entry) => entry.id)
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, ARCHIVE_LIMIT),
    preferences,
  };
}

/** What is saved: everything except private tabs. When a private tab is current, the newest saved tab is. */
export function persistedBrowserData(data: BrowserData): BrowserData {
  if (!data.tabs.some((tab) => tab.private)) return data;
  const tabs = data.tabs.filter((tab) => !tab.private);
  const activeTabId = tabs.some((tab) => tab.id === data.activeTabId) ? data.activeTabId : (tabs[tabs.length - 1]?.id ?? "");
  return { ...data, tabs, activeTabId };
}
