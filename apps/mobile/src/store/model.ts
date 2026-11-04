import type {
  ArchivedTab,
  BrowserData,
  BrowserPreferences,
  BrowserTab,
  DownloadItem,
  HistoryEntry,
  PinnedSite,
  SimplePreferences,
  TabUpdate,
  WallpaperId,
} from "./types";
import type { ReaderSettings } from "../pagescripts/reader.ts";

export const DEFAULT_PREFERENCES: BrowserPreferences = {
  searchEngineId: "google",
  archiveAfterDays: 7,
  blockContent: true,
  blockingPausedHosts: [],
  lockPrivateTabs: false,
  reader: { theme: "paper", font: "serif", size: 19 },
  hiddenElements: {},
  wallpaper: "bay",
  wallpaperPhoto: null,
  theme: "system",
  textSize: 100,
  searchSuggestions: true,
  skipAmp: true,
  pullToRefresh: true,
  startPageAfterHours: null,
  youtube: { shorts: false, suggestions: false, distractions: false },
};
export const TEXT_SIZE = { min: 80, max: 200, step: 10 } as const;
export const START_PAGE_HOURS = [null, 1, 4, 12] as const;
/** Bay's own wallpapers; "photo" is the user's. */
export const WALLPAPERS = ["bay", "dusk", "forest", "plain"] as const;
const builtIn = (id: unknown): id is WallpaperId => (WALLPAPERS as readonly unknown[]).includes(id);
const isFileUri = (uri: unknown): uri is string => typeof uri === "string" && uri.startsWith("file://");
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 1000;
const ARCHIVE_LIMIT = 200;
const DOWNLOAD_LIMIT = 100;
const FAVICON_LIMIT = 500;

/** The key icons are kept under: a URL's host without "www.". */
export function siteHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return (match?.[1] ?? "").toLowerCase().replace(/^www\./, "");
}
const DOWNLOAD_STATES = ["downloading", "finished", "failed", "cancelled"] as const;

/** A download update from the engine (`DownloadUpdate` in @bay/engine). */
export interface DownloadEvent {
  id: string;
  url: string;
  filename: string;
  state: "started" | "progress" | "finished" | "failed" | "cancelled";
  received: number;
  total: number;
  path?: string;
  error?: string;
  private: boolean;
}

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
    downloads: [],
    favicons: {},
    leftAt: null,
    preferences: {
      ...preferences,
      blockingPausedHosts: [...preferences.blockingPausedHosts],
      reader: { ...preferences.reader },
      hiddenElements: Object.fromEntries(Object.entries(preferences.hiddenElements).map(([host, selectors]) => [host, [...selectors]])),
    },
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
  | { type: "remove-pin"; id: string }
  | { type: "add-pin"; site: PinnedSite; index: number }
  | { type: "remove-history"; url: string }
  | { type: "clear-history" }
  | { type: "favicon"; host: string; uri: string | null }
  | { type: "remove-archived"; id: string }
  | { type: "clear-archive" }
  | { type: "wallpaper"; id: WallpaperId; photo?: string }
  | { type: "search-engine"; id: string }
  | { type: "archive-days"; days: number | null }
  | { type: "archive-stale"; now: number }
  | { type: "block-content"; enabled: boolean }
  | { type: "pause-blocking"; host: string; paused: boolean }
  | { type: "lock-private-tabs"; enabled: boolean }
  | { type: "preferences"; update: Partial<SimplePreferences> }
  | { type: "left"; now: number }
  | { type: "reader-settings"; settings: ReaderSettings }
  | { type: "hidden-elements"; host: string; selectors: string[] }
  | { type: "download"; update: DownloadEvent; now: number }
  | { type: "remove-download"; id: string }
  | { type: "clear-downloads" };

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
        archive: tab.url && !tab.private ? archiveTabs(data.archive, [tab], action.now) : data.archive,
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
    case "remove-pin":
      return { ...data, pinnedSites: data.pinnedSites.filter((site) => site.id !== action.id) };
    case "add-pin": {
      if (data.pinnedSites.some((site) => site.url === action.site.url)) return data;
      const pinnedSites = [...data.pinnedSites];
      pinnedSites.splice(action.index, 0, action.site);
      return { ...data, pinnedSites };
    }
    case "remove-history":
      return { ...data, history: data.history.filter((entry) => entry.url !== action.url) };
    case "remove-archived":
      return data.archive.some((tab) => tab.id === action.id) ? { ...data, archive: data.archive.filter((tab) => tab.id !== action.id) } : data;
    case "clear-archive":
      return data.archive.length ? { ...data, archive: [] } : data;
    case "wallpaper": {
      // A new photo replaces the old one; picking a built-in keeps the photo for switching back.
      const photo = action.id === "photo" ? (action.photo ?? data.preferences.wallpaperPhoto) : data.preferences.wallpaperPhoto;
      if (!(builtIn(action.id) || (action.id === "photo" && isFileUri(photo)))) return data;
      if (action.id === data.preferences.wallpaper && photo === data.preferences.wallpaperPhoto) return data;
      return { ...data, preferences: { ...data.preferences, wallpaper: action.id, wallpaperPhoto: photo } };
    }
    case "clear-history": {
      if (!data.history.length) return data;
      // Icons stay for sites a tab, the archive or a pin still shows.
      const shown = new Set([...data.tabs, ...data.archive, ...data.pinnedSites].map((entry) => siteHost(entry.url)));
      return { ...data, history: [], favicons: Object.fromEntries(Object.entries(data.favicons).filter(([host]) => shown.has(host))) };
    }
    case "favicon": {
      if ((data.favicons[action.host] ?? null) === action.uri) return data;
      const { [action.host]: _previous, ...rest } = data.favicons;
      if (action.uri === null) return { ...data, favicons: rest };
      // Oldest first, so the cap drops the icons fetched longest ago.
      return { ...data, favicons: Object.fromEntries([...Object.entries(rest), [action.host, action.uri]].slice(-FAVICON_LIMIT)) };
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
    case "left":
      return { ...data, leftAt: action.now };
    case "preferences": {
      // Only the updated keys come from the parse, so untouched preferences (and their arrays) stay the same objects.
      const parsed = parsePreferences({ ...data.preferences, ...action.update });
      const keys = Object.keys(action.update) as (keyof SimplePreferences)[];
      if (keys.every((key) => JSON.stringify(parsed[key]) === JSON.stringify(data.preferences[key]))) return data;
      return { ...data, preferences: { ...data.preferences, ...Object.fromEntries(keys.map((key) => [key, parsed[key]])) } };
    }
    case "reader-settings": {
      const reader = parseReaderSettings(action.settings, data.preferences.reader);
      const previous = data.preferences.reader;
      return reader.theme === previous.theme && reader.font === previous.font && reader.size === previous.size
        ? data
        : { ...data, preferences: { ...data.preferences, reader } };
    }
    case "hidden-elements": {
      const host = normalizeHost(action.host);
      if (!host) return data;
      const selectors = parseSelectors(action.selectors);
      const previous = Object.hasOwn(data.preferences.hiddenElements, host) ? data.preferences.hiddenElements[host] : [];
      if (selectors.length === previous.length && selectors.every((selector, index) => selector === previous[index])) return data;
      const hiddenElements = { ...data.preferences.hiddenElements };
      if (selectors.length) hiddenElements[host] = selectors;
      else delete hiddenElements[host];
      return { ...data, preferences: { ...data.preferences, hiddenElements } };
    }
    case "download": {
      const { update } = action;
      const previous = data.downloads.find((item) => item.id === update.id);
      const state = update.state === "started" || update.state === "progress" ? "downloading" : update.state;
      // The engine says nothing more after a final state; a late progress update can't revive it.
      if (previous && previous.state !== "downloading") return data;
      const item: DownloadItem = {
        id: update.id,
        url: update.url || previous?.url || "",
        // The engine knows the real name once the response arrives; a cancelled update may not.
        filename: update.filename && update.filename !== "download" ? update.filename : (previous?.filename ?? update.filename),
        state,
        received: update.received,
        total: update.total || previous?.total || 0,
        ...(update.path ? { path: update.path } : previous?.path ? { path: previous.path } : {}),
        ...(update.error ? { error: update.error } : {}),
        startedAt: previous?.startedAt ?? action.now,
        ...(update.private ? { private: true } : {}),
      };
      // Engines repeat unchanged progress; keep the same data so nothing re-renders.
      if (
        previous &&
        item.state === previous.state &&
        item.received === previous.received &&
        item.total === previous.total &&
        item.path === previous.path &&
        item.filename === previous.filename &&
        item.url === previous.url &&
        item.error === previous.error &&
        item.private === previous.private
      )
        return data;
      return {
        ...data,
        downloads: (previous ? data.downloads.map((entry) => (entry.id === update.id ? item : entry)) : [item, ...data.downloads]).slice(0, DOWNLOAD_LIMIT),
      };
    }
    case "remove-download":
      return data.downloads.some((item) => item.id === action.id) ? { ...data, downloads: data.downloads.filter((item) => item.id !== action.id) } : data;
    case "clear-downloads": {
      // Downloads still running stay listed.
      const downloads = data.downloads.filter((item) => item.state === "downloading");
      return downloads.length === data.downloads.length ? data : { ...data, downloads };
    }
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
        archive: archiveTabs(data.archive, stale, action.now),
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

function parseReaderSettings(value: unknown, fallback = DEFAULT_PREFERENCES.reader): ReaderSettings {
  const settings = isRecord(value) ? value : {};
  return {
    theme: ["light", "paper", "sepia", "mint", "gray", "dark", "black"].includes(settings.theme as string)
      ? (settings.theme as ReaderSettings["theme"])
      : fallback.theme,
    font: ["serif", "sans", "mono"].includes(settings.font as string) ? (settings.font as ReaderSettings["font"]) : fallback.font,
    size: typeof settings.size === "number" && Number.isFinite(settings.size) ? Math.min(28, Math.max(14, Math.round(settings.size))) : fallback.size,
  };
}

function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const host = value.toLowerCase().replace(/^www\./, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])$/.test(host)) return null;
  try {
    return new URL(`https://${host}`).hostname === host ? host : null;
  } catch {
    return null;
  }
}

function parseSelectors(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((selector): selector is string => typeof selector === "string")
            .map((selector) => selector.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function parseHiddenElements(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).flatMap(([key, value]) => {
    const host = normalizeHost(key);
    const selectors = parseSelectors(value);
    return host && selectors.length ? [[host, selectors] as const] : [];
  });
  return Object.fromEntries(entries);
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

/** Newest first, one entry per address: archiving a page again replaces its older copy. */
function archiveTabs(archive: ArchivedTab[], tabs: BrowserTab[], now: number): ArchivedTab[] {
  const urls = new Set(tabs.map((tab) => tab.url));
  const ids = new Set(tabs.map((tab) => tab.id));
  return [
    ...uniqueBy(tabs, (tab) => tab.url).map((tab) => ({ ...tab, closedAt: now })),
    ...archive.filter((entry) => !urls.has(entry.url) && !ids.has(entry.id)),
  ].slice(0, ARCHIVE_LIMIT);
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
  const downloads: DownloadItem[] = (Array.isArray(value.downloads) ? value.downloads : []).filter(isRecord).flatMap((entry) => {
    if (typeof entry.id !== "string" || !entry.id || typeof entry.filename !== "string" || !isTimestamp(entry.startedAt)) return [];
    if (!DOWNLOAD_STATES.includes(entry.state as DownloadItem["state"])) return [];
    const bytes = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
    // A download Bay was running when it quit can't be resumed.
    const interrupted = entry.state === "downloading";
    return [
      {
        id: entry.id,
        url: typeof entry.url === "string" ? entry.url : "",
        filename: entry.filename,
        state: interrupted ? "failed" : (entry.state as DownloadItem["state"]),
        received: bytes(entry.received),
        total: bytes(entry.total),
        ...(typeof entry.path === "string" && entry.path ? { path: entry.path } : {}),
        ...(interrupted ? { error: "Bay closed before it finished." } : typeof entry.error === "string" ? { error: entry.error } : {}),
        startedAt: entry.startedAt,
      },
    ];
  });
  const preferences = parsePreferences(isRecord(value.preferences) ? value.preferences : {});
  return {
    tabs: tabs.length ? tabs : fallback.tabs,
    activeTabId: tabs.some((tab) => tab.id === value.activeTabId) ? (value.activeTabId as string) : (tabs[0]?.id ?? fallback.activeTabId),
    history: uniqueBy(history, (entry) => entry.url)
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, HISTORY_LIMIT),
    pinnedSites: uniqueBy(pinnedSites, (entry) => entry.url),
    archive: uniqueBy(
      uniqueBy(
        archive.sort((a, b) => b.closedAt - a.closedAt),
        (entry) => entry.url,
      ),
      (entry) => entry.id,
    ).slice(0, ARCHIVE_LIMIT),
    downloads: uniqueBy(downloads, (entry) => entry.id)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, DOWNLOAD_LIMIT),
    preferences,
    favicons: Object.fromEntries(
      Object.entries(isRecord(value.favicons) ? value.favicons : {})
        .filter((entry): entry is [string, string] => /^[a-z0-9.-]+$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].startsWith("file://"))
        .slice(-FAVICON_LIMIT),
    ),
    leftAt: typeof value.leftAt === "number" && Number.isFinite(value.leftAt) ? value.leftAt : null,
  };
}

/** Saved preferences with anything unknown or out of range replaced by its default. */
export function parsePreferences(savedPreferences: Record<string, unknown>): BrowserPreferences {
  return {
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
    reader: parseReaderSettings(savedPreferences.reader),
    hiddenElements: parseHiddenElements(savedPreferences.hiddenElements),
    wallpaper:
      builtIn(savedPreferences.wallpaper) || (savedPreferences.wallpaper === "photo" && isFileUri(savedPreferences.wallpaperPhoto))
        ? (savedPreferences.wallpaper as WallpaperId)
        : DEFAULT_PREFERENCES.wallpaper,
    wallpaperPhoto: isFileUri(savedPreferences.wallpaperPhoto) ? savedPreferences.wallpaperPhoto : null,
    theme: (["system", "light", "dark"] as unknown[]).includes(savedPreferences.theme) ? (savedPreferences.theme as BrowserPreferences["theme"]) : "system",
    textSize:
      typeof savedPreferences.textSize === "number" && savedPreferences.textSize >= TEXT_SIZE.min && savedPreferences.textSize <= TEXT_SIZE.max
        ? Math.round(savedPreferences.textSize / TEXT_SIZE.step) * TEXT_SIZE.step
        : DEFAULT_PREFERENCES.textSize,
    searchSuggestions: savedPreferences.searchSuggestions !== false,
    skipAmp: savedPreferences.skipAmp !== false,
    pullToRefresh: savedPreferences.pullToRefresh !== false,
    startPageAfterHours: (START_PAGE_HOURS as readonly unknown[]).includes(savedPreferences.startPageAfterHours)
      ? (savedPreferences.startPageAfterHours as number | null)
      : null,
    youtube: {
      shorts: isRecord(savedPreferences.youtube) && savedPreferences.youtube.shorts === true,
      suggestions: isRecord(savedPreferences.youtube) && savedPreferences.youtube.suggestions === true,
      distractions: isRecord(savedPreferences.youtube) && savedPreferences.youtube.distractions === true,
    },
  };
}

/** What is saved: everything except private tabs. When a private tab is current, the newest saved tab is. */
export function persistedBrowserData(data: BrowserData): BrowserData {
  const downloads = data.downloads.some((item) => item.private) ? data.downloads.filter((item) => !item.private) : data.downloads;
  if (!data.tabs.some((tab) => tab.private)) return downloads === data.downloads ? data : { ...data, downloads };
  const tabs = data.tabs.filter((tab) => !tab.private);
  const activeTabId = tabs.some((tab) => tab.id === data.activeTabId) ? data.activeTabId : (tabs[tabs.length - 1]?.id ?? "");
  return { ...data, tabs, activeTabId, downloads };
}
