import * as v from "valibot";
import { SIMPLE_PREFERENCE_KEYS, TAB_UPDATE_FIELDS } from "./types.ts";
import type {
  ArchivedTab,
  BrowserData,
  BrowserFolder,
  BrowserPreferences,
  BrowserSpace,
  BrowserTab,
  DownloadItem,
  HistoryEntry,
  JsonObject,
  JsonValue,
  PinnedSite,
  SimplePreferences,
  SiteSetting,
  SpaceColor,
  TabUpdate,
  WallpaperId,
} from "./types";

export type { SiteSetting };

import type { ReaderSettings } from "../pagescripts/reader.ts";

export const DEFAULT_PREFERENCES: BrowserPreferences = {
  searchEngineId: "google",
  archiveAfterDays: 7,
  blockContent: true,
  blockingPausedHosts: [],
  lockPrivateTabs: false,
  reader: { theme: "paper", font: "serif", size: 19 },
  hiddenElements: {},
  siteSettings: {},
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

/** What a site with no entry of its own keeps: every global choice. */
export const EMPTY_SITE_SETTING: SiteSetting = { textSize: null, reader: false, desktopMode: false };

/** A site's stored setting, or the default when it has none. */
export function siteSettingFor(siteSettings: Record<string, SiteSetting>, url: string): SiteSetting {
  return siteSettings[siteHost(url)] ?? EMPTY_SITE_SETTING;
}

/** Bay's own wallpapers; "photo" is the user's. */
export const WALLPAPERS = ["bay", "dusk", "forest", "plain"] as const;
const builtIn = (id: JsonValue): id is WallpaperId => v.is(v.picklist(WALLPAPERS), id);
const isFileUri = (uri: JsonValue): uri is string => v.is(v.string(), uri) && uri.startsWith("file://");
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

/** The one space every tab started in: documents saved before spaces existed (v1) land here. */
export const PERSONAL_SPACE_ID = "personal";
export const PERSONAL_SPACE: BrowserSpace = { id: PERSONAL_SPACE_ID, name: "Personal", color: "blue" };

/** The error a download keeps when Bay closed during it; shown in the reader's language when it is read back. */
export const INTERRUPTED_DOWNLOAD = "Bay closed before it finished.";

export const SPACE_COLORS: readonly SpaceColor[] = ["blue", "green", "orange", "red", "violet", "gray"];
const SPACE_COLOR_PICKLIST: readonly SpaceColor[] = SPACE_COLORS;

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
  waiting?: string;
  private: boolean;
}

export function createTab(id: string, now: number, url = "", isPrivate = false, spaceId = PERSONAL_SPACE_ID): BrowserTab {
  return { id, url, title: "", favicon: null, createdAt: now, lastVisit: now, snapshot: null, spaceId, ...(isPrivate ? { private: true } : undefined) };
}

export function initialBrowserData(tab: BrowserTab, preferences = DEFAULT_PREFERENCES): BrowserData {
  return {
    tabs: [tab],
    spaces: [{ ...PERSONAL_SPACE }],
    activeSpaceId: PERSONAL_SPACE_ID,
    activeTabIds: { [PERSONAL_SPACE_ID]: tab.id },
    folders: [],
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
      siteSettings: Object.fromEntries(Object.entries(preferences.siteSettings).map(([host, setting]) => [host, { ...setting }])),
    },
  };
}

export type BrowserAction =
  | { type: "new-tab"; tab: BrowserTab; background: boolean }
  | { type: "import-tabs"; tabs: BrowserTab[] }
  | { type: "import-archive"; tabs: BrowserTab[]; now: number }
  | { type: "activate-tab"; id: string; now: number }
  | { type: "update-tab"; id: string; update: TabUpdate }
  | { type: "visit"; url: string; title: string; favicon: string | null; now: number }
  | { type: "page-title"; url: string; title: string }
  | { type: "close-tab"; id: string; now: number; fallback: BrowserTab }
  | { type: "restore-tab"; id: string; restoredId: string; now: number }
  | { type: "create-space"; space: BrowserSpace; blankTab: BrowserTab }
  | { type: "rename-space"; id: string; name: string }
  | { type: "reorder-space"; id: string; to: number }
  | { type: "delete-space"; id: string }
  | { type: "select-space"; id: string; blankTab?: BrowserTab }
  | { type: "new-folder"; folder: BrowserFolder }
  | { type: "rename-folder"; id: string; name: string }
  | { type: "delete-folder"; id: string }
  | { type: "move-tab"; id: string; spaceId: string; folderId: string | null }
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
  | { type: "site-settings"; host: string; update: SiteSetting }
  | { type: "download"; update: DownloadEvent; now: number }
  | { type: "remove-download"; id: string }
  | { type: "clear-downloads" };

export function reduceBrowserData(data: BrowserData, action: BrowserAction): BrowserData {
  switch (action.type) {
    case "new-tab":
      return data.tabs.some((tab) => tab.id === action.tab.id)
        ? data
        : {
            ...data,
            tabs: [...data.tabs, action.tab],
            activeTabId: action.background ? data.activeTabId : action.tab.id,
            activeTabIds: action.background ? data.activeTabIds : { ...data.activeTabIds, [action.tab.spaceId]: action.tab.id },
          };
    case "import-tabs": {
      // A link that is already open stays where it is; importing again shouldn't duplicate tabs.
      const open = new Set(data.tabs.map((tab) => tab.url));
      const tabs = action.tabs.filter((tab) => tab.url && !open.has(tab.url));

      return tabs.length ? { ...data, tabs: [...data.tabs, ...tabs] } : data;
    }

    case "import-archive": {
      const tabs = action.tabs.filter((tab) => tab.url && !tab.private);

      return tabs.length ? { ...data, archive: archiveTabs(data.archive, tabs, action.now) } : data;
    }

    case "activate-tab": {
      const tab = data.tabs.find((entry) => entry.id === action.id);

      if (!tab) return data;

      return {
        ...data,
        activeTabId: action.id,
        activeTabIds: { ...data.activeTabIds, [tab.spaceId]: action.id },
        tabs: data.tabs.map((entry) => (entry.id === action.id ? { ...entry, lastVisit: action.now } : entry)),
      };
    }

    case "update-tab": {
      const tab = data.tabs.find((entry) => entry.id === action.id);

      if (!tab) return data;
      const fields = TAB_UPDATE_FIELDS.filter((field) => Object.hasOwn(action.update, field));

      if (fields.every((field) => tab[field] === action.update[field])) return data;

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

      // The space's own current pointer follows whichever neighbour is closest in list order; when the space
      // empties out the caller-supplied fallback (in the same space) is appended by the caller already, so its
      // activeTabIds entry is simply dropped and re-set by the next activation.
      const activeTabIds = { ...data.activeTabIds };

      if (data.activeTabIds[tab.spaceId] === action.id) {
        const inSpace = remaining.filter((entry) => entry.spaceId === tab.spaceId);

        if (inSpace.length) activeTabIds[tab.spaceId] = inSpace[Math.min(index, inSpace.length - 1)].id;
        else delete activeTabIds[tab.spaceId];
      }

      // When the tab on screen closes, its space is next in line; without a same-space tab left, find any tab.
      const nextActive =
        data.activeTabId === action.id
          ? (tabs.find((entry) => entry.spaceId === tab.spaceId)?.id ?? tabs[Math.min(index, tabs.length - 1)].id)
          : data.activeTabId;

      return {
        ...data,
        tabs,
        activeTabId: nextActive,
        activeTabIds,
        // Private tabs leave nothing behind.
        archive: tab.url && !tab.private ? archiveTabs(data.archive, [tab], action.now) : data.archive,
      };
    }

    case "restore-tab": {
      const archived = data.archive.find((tab) => tab.id === action.id);

      if (!archived) return data;
      const { closedAt: _closedAt, ...tab } = archived;

      const restored = {
        ...tab,
        id: action.restoredId,
        spaceId: data.spaces.some((space) => space.id === tab.spaceId) ? tab.spaceId : PERSONAL_SPACE_ID,
        lastVisit: action.now,
      };

      return {
        ...data,
        tabs: [...data.tabs, restored],
        activeTabId: restored.id,
        activeTabIds: { ...data.activeTabIds, [restored.spaceId]: restored.id },
        archive: data.archive.filter((entry) => entry.id !== action.id),
      };
    }

    case "create-space":
      return {
        ...data,
        spaces: [...data.spaces, action.space],
        tabs: [...data.tabs, action.blankTab],
        activeSpaceId: action.space.id,
        activeTabIds: { ...data.activeTabIds, [action.space.id]: action.blankTab.id },
        activeTabId: action.blankTab.id,
      };

    case "rename-space": {
      if (!data.spaces.some((space) => space.id === action.id) || !action.name.trim()) return data;

      return { ...data, spaces: data.spaces.map((space) => (space.id === action.id ? { ...space, name: action.name.trim().slice(0, 40) } : space)) };
    }

    case "reorder-space": {
      const from = data.spaces.findIndex((space) => space.id === action.id);

      if (from < 0) return data;
      const to = Math.max(0, Math.min(action.to, data.spaces.length - 1));

      if (from === to) return data;
      const spaces = [...data.spaces];
      const [moved] = spaces.splice(from, 1);
      spaces.splice(to, 0, moved);

      return { ...data, spaces };
    }

    case "delete-space": {
      const remaining = data.spaces.filter((space) => space.id !== action.id);

      if (remaining.length === 0 || !data.spaces.some((space) => space.id === action.id)) return data;
      const destination = remaining[0]!.id;
      const activeSpaceId = data.activeSpaceId === action.id ? destination : data.activeSpaceId;
      const afterTabs = data.tabs.map((tab) => (tab.spaceId === action.id ? { ...tab, spaceId: destination, folderId: null } : tab));
      const activeTabIds = Object.fromEntries(Object.entries(data.activeTabIds).filter(([spaceId]) => spaceId !== action.id));

      return {
        ...data,
        spaces: remaining,
        folders: data.folders.filter((folder) => folder.spaceId !== action.id),
        tabs: afterTabs,
        activeSpaceId,
        activeTabIds,
        // The tab the screen is sitting on now lives in the destination space, so the active pointer survives as is.
        activeTabId: data.activeTabId,
      };
    }

    case "select-space": {
      if (!data.spaces.some((space) => space.id === action.id)) return data;
      const inSpace = data.tabs.filter((tab) => tab.spaceId === action.id);
      const retained = data.activeTabIds[action.id];
      let activeTabId = retained && inSpace.some((tab) => tab.id === retained) ? retained : inSpace[inSpace.length - 1]?.id;
      let { tabs } = data;

      if (!activeTabId) {
        if (!action.blankTab) return data;
        tabs = [...tabs, action.blankTab];
        activeTabId = action.blankTab.id;
      }

      return {
        ...data,
        tabs,
        activeSpaceId: action.id,
        activeTabId,
        activeTabIds: { ...data.activeTabIds, [action.id]: activeTabId },
      };
    }

    case "new-folder":
      if (!data.spaces.some((space) => space.id === action.folder.spaceId)) return data;

      return { ...data, folders: [...data.folders, action.folder] };

    case "rename-folder": {
      if (!data.folders.some((folder) => folder.id === action.id) || !action.name.trim()) return data;

      return { ...data, folders: data.folders.map((folder) => (folder.id === action.id ? { ...folder, name: action.name.trim().slice(0, 40) } : folder)) };
    }

    case "delete-folder": {
      if (!data.folders.some((folder) => folder.id === action.id)) return data;

      return {
        ...data,
        folders: data.folders.filter((folder) => folder.id !== action.id),
        tabs: data.tabs.map((tab) => (tab.folderId === action.id ? { ...tab, folderId: null } : tab)),
      };
    }

    case "move-tab": {
      const tab = data.tabs.find((entry) => entry.id === action.id);

      if (!tab || !data.spaces.some((space) => space.id === action.spaceId)) return data;

      if (tab.spaceId === action.spaceId && tab.folderId === action.folderId) return data;
      const activeTabIds = { ...data.activeTabIds };

      // The space left behind keeps its own current tab (nearest remaining in list order).
      if (data.activeTabIds[tab.spaceId] === action.id) {
        const left = data.tabs.filter((entry) => entry.spaceId === tab.spaceId && entry.id !== action.id);

        if (left.length) activeTabIds[tab.spaceId] = left[left.length - 1]!.id;
        else delete activeTabIds[tab.spaceId];
      }

      const tabs = data.tabs.map((entry) => (entry.id === action.id ? { ...entry, spaceId: action.spaceId, folderId: action.folderId } : entry));
      // If the tab on screen moves, its space follows it.
      const following = data.activeTabId === action.id && action.spaceId !== data.activeSpaceId;

      return {
        ...data,
        tabs,
        activeTabIds,
        activeSpaceId: following ? action.spaceId : data.activeSpaceId,
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
      return [null, 0.5, 1, 7, 30].includes(action.days) && action.days !== data.preferences.archiveAfterDays
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
      const keys = SIMPLE_PREFERENCE_KEYS.filter((key) => Object.hasOwn(action.update, key));

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

    case "site-settings": {
      const host = normalizeHost(action.host);

      if (!host) return data;
      const setting = parseSiteSetting(action.update);
      const previous = Object.hasOwn(data.preferences.siteSettings, host) ? data.preferences.siteSettings[host] : null;

      if (sameSiteSetting(previous, setting)) return data;
      const siteSettings = { ...data.preferences.siteSettings };

      // An entry with nothing of its own left adds nothing; the site follows the globals again.
      if (isDefaultSiteSetting(setting)) delete siteSettings[host];
      else siteSettings[host] = setting;

      return { ...data, preferences: { ...data.preferences, siteSettings } };
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
        ...(update.error ? { error: update.error } : undefined),
        ...(update.waiting && state === "downloading" ? { waiting: update.waiting } : undefined),
        startedAt: previous?.startedAt ?? action.now,
        ...(update.private ? { private: true } : undefined),
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
        item.waiting === previous.waiting &&
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
      const activeTabIds = Object.fromEntries(Object.entries(data.activeTabIds).filter(([spaceId, tabId]) => !ids.has(tabId) && spaceId.length > 0));

      return {
        ...data,
        tabs: data.tabs.filter((tab) => !ids.has(tab.id)),
        activeTabIds,
        archive: archiveTabs(data.archive, stale, action.now),
      };
    }
  }
}

function isRecord(value: JsonValue): value is JsonObject {
  return v.is(v.object({}), value) && !Array.isArray(value);
}

function isTimestamp(value: JsonValue): value is number {
  return v.is(v.number(), value) && Number.isFinite(value) && value >= 0;
}

const READER_THEME_IDS = ["light", "paper", "sepia", "mint", "gray", "dark", "black"] as const;
const READER_FONT_IDS = ["serif", "sans", "mono"] as const;

function parseReaderSettings(value: JsonValue, fallback = DEFAULT_PREFERENCES.reader): ReaderSettings {
  const settings: JsonObject = isRecord(value) ? value : {};

  return {
    theme: v.is(v.picklist(READER_THEME_IDS), settings.theme) ? settings.theme : fallback.theme,
    font: v.is(v.picklist(READER_FONT_IDS), settings.font) ? settings.font : fallback.font,
    size: v.is(v.number(), settings.size) && Number.isFinite(settings.size) ? Math.min(28, Math.max(14, Math.round(settings.size))) : fallback.size,
  };
}

function normalizeHost(value: JsonValue): string | null {
  if (!v.is(v.string(), value) || !value) return null;
  const host = value.toLowerCase().replace(/^www\./, "");

  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])$/.test(host)) return null;

  try {
    return new URL(`https://${host}`).hostname === host ? host : null;
  } catch {
    return null;
  }
}

function parseSelectors(value: JsonValue): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((selector): selector is string => v.is(v.string(), selector))
            .map((selector) => selector.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function parseHiddenElements(value: JsonValue): Record<string, string[]> {
  if (!isRecord(value)) return {};

  const entries = Object.entries(value).flatMap(([key, value]) => {
    const host = normalizeHost(key);
    const selectors = parseSelectors(value);

    return host && selectors.length ? [[host, selectors] as const] : [];
  });

  return Object.fromEntries(entries);
}

/** One site's setting as saved: zoom snapped to the steps, the rest plainly true or false. */
export function parseSiteSetting(value: JsonValue): SiteSetting {
  const setting: JsonObject = isRecord(value) ? value : {};

  return {
    textSize:
      v.is(v.number(), setting.textSize) && Number.isFinite(setting.textSize)
        ? Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, Math.round(setting.textSize / TEXT_SIZE.step) * TEXT_SIZE.step))
        : null,
    reader: setting.reader === true,
    desktopMode: setting.desktopMode === true,
  };
}

function isDefaultSiteSetting(setting: SiteSetting): boolean {
  return setting.textSize === null && !setting.reader && !setting.desktopMode;
}

function sameSiteSetting(previous: SiteSetting | null, setting: SiteSetting): boolean {
  return previous !== null && previous.textSize === setting.textSize && previous.reader === setting.reader && previous.desktopMode === setting.desktopMode;
}

function parseSiteSettings(value: JsonValue): Record<string, SiteSetting> {
  if (!isRecord(value)) return {};

  const entries = Object.entries(value).flatMap(([key, value]) => {
    const host = normalizeHost(key);
    const setting = parseSiteSetting(value);

    return host && !isDefaultSiteSetting(setting) ? [[host, setting] as const] : [];
  });

  return Object.fromEntries(entries);
}

function isWebAddress(value: JsonValue): value is string {
  if (!v.is(v.string(), value)) return false;

  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function parseTab(value: JsonValue): BrowserTab | null {
  if (
    !isRecord(value) ||
    !v.is(v.string(), value.id) ||
    !value.id ||
    !v.is(v.string(), value.title) ||
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
    favicon: v.is(v.string(), value.favicon) ? value.favicon : null,
    snapshot: v.is(v.string(), value.snapshot) && value.snapshot.startsWith("file://") ? value.snapshot : null,
    spaceId: PERSONAL_SPACE_ID,
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
export function parseBrowserData(value: JsonValue, fallback: BrowserData): BrowserData {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) throw new Error("The saved browsing state could not be read.");

  // Spaces and folders (B21): documents saved before them existed (v1) have none; everything falls into the
  // personal space.
  const savedSpaces = (Array.isArray(value.spaces) ? value.spaces : []).flatMap((entry): BrowserSpace[] =>
    isRecord(entry) && v.is(v.string(), entry.id) && entry.id
      ? [
          {
            id: entry.id,
            name: v.is(v.string(), entry.name) && entry.name ? entry.name.slice(0, 40) : "Space",
            color: v.is(v.picklist(SPACE_COLOR_PICKLIST), entry.color) ? entry.color : "gray",
          },
        ]
      : [],
  );

  const spaces: BrowserSpace[] = savedSpaces.length ? savedSpaces : [{ id: PERSONAL_SPACE_ID, name: "Personal", color: "blue" }];
  const spaceIds = new Set(spaces.map((space) => space.id));

  const savedFolders = (Array.isArray(value.folders) ? value.folders : []).flatMap((entry): BrowserFolder[] =>
    isRecord(entry) &&
    v.is(v.string(), entry.id) &&
    entry.id &&
    v.is(v.string(), entry.spaceId) &&
    spaceIds.has(entry.spaceId) &&
    v.is(v.string(), entry.name) &&
    entry.name
      ? [{ id: entry.id, spaceId: entry.spaceId, name: entry.name.slice(0, 40) }]
      : [],
  );

  const tabs = uniqueBy(
    (Array.isArray(value.tabs) ? value.tabs : [])
      .map((entry) => {
        const parsed = parseTab(entry);

        if (!parsed) return null;
        const spaceId = isRecord(entry) && v.is(v.string(), entry.spaceId) && spaceIds.has(entry.spaceId) ? entry.spaceId : PERSONAL_SPACE_ID;

        const folderId =
          isRecord(entry) && v.is(v.string(), entry.folderId) && savedFolders.some((folder) => folder.id === entry.folderId) ? entry.folderId : null;

        const parsedTab: BrowserTab = { ...parsed, spaceId };

        if (folderId) parsedTab.folderId = folderId;

        return parsedTab;
      })
      .filter((tab): tab is BrowserTab => tab !== null),
    (tab) => tab.id,
  );

  const history: HistoryEntry[] = (Array.isArray(value.history) ? value.history : []).filter(isRecord).flatMap((entry) =>
    isWebAddress(entry.url) &&
    v.is(v.string(), entry.title) &&
    isTimestamp(entry.lastVisit) &&
    v.is(v.number(), entry.visits) &&
    Number.isFinite(entry.visits) &&
    entry.visits > 0
      ? [
          {
            url: entry.url,
            title: entry.title,
            favicon: v.is(v.string(), entry.favicon) ? entry.favicon : null,
            lastVisit: entry.lastVisit,
            visits: Math.floor(entry.visits),
          },
        ]
      : [],
  );

  const pinnedSites: PinnedSite[] = (Array.isArray(value.pinnedSites) ? value.pinnedSites : [])
    .filter(isRecord)
    .flatMap((entry) =>
      v.is(v.string(), entry.id) && entry.id && isWebAddress(entry.url) && v.is(v.string(), entry.title)
        ? [{ id: entry.id, url: entry.url, title: entry.title, favicon: v.is(v.string(), entry.favicon) ? entry.favicon : null }]
        : [],
    );

  const archive: ArchivedTab[] = (Array.isArray(value.archive) ? value.archive : []).flatMap((entry) => {
    const tab = parseTab(entry);

    return tab?.url && isRecord(entry) && isTimestamp(entry.closedAt) ? [{ ...tab, closedAt: entry.closedAt }] : [];
  });

  const downloads: DownloadItem[] = (Array.isArray(value.downloads) ? value.downloads : []).filter(isRecord).flatMap((entry) => {
    if (!v.is(v.string(), entry.id) || !entry.id || !v.is(v.string(), entry.filename) || !isTimestamp(entry.startedAt)) return [];

    if (!v.is(v.picklist(DOWNLOAD_STATES), entry.state)) return [];
    const bytes = (value: JsonValue) => (v.is(v.number(), value) && Number.isFinite(value) && value > 0 ? value : 0);
    // A download Bay was running when it quit can't be resumed.
    const interrupted = entry.state === "downloading";

    return [
      {
        id: entry.id,
        url: v.is(v.string(), entry.url) ? entry.url : "",
        filename: entry.filename,
        state: interrupted ? "failed" : entry.state,
        received: bytes(entry.received),
        total: bytes(entry.total),
        ...(v.is(v.string(), entry.path) && entry.path ? { path: entry.path } : undefined),
        ...(interrupted ? { error: INTERRUPTED_DOWNLOAD } : v.is(v.string(), entry.error) ? { error: entry.error } : {}),
        startedAt: entry.startedAt,
      },
    ];
  });

  const preferences = parsePreferences(isRecord(value.preferences) ? value.preferences : {});

  const activeTab = tabs.find((tab) => tab.id === value.activeTabId);
  const activeSpaceId = v.is(v.string(), value.activeSpaceId) && spaceIds.has(value.activeSpaceId) ? value.activeSpaceId : spaces[0]!.id;

  const activeTabIds = Object.fromEntries(
    Object.entries(isRecord(value.activeTabIds) ? value.activeTabIds : {}).filter(
      (entry): entry is [string, string] => spaceIds.has(entry[0]) && tabs.some((tab) => tab.id === entry[1]),
    ),
  );

  const resolvedActiveTabId = activeTab?.id ?? tabs.find((tab) => tab.spaceId === activeSpaceId)?.id ?? tabs[0]?.id ?? fallback.activeTabId;

  if (resolvedActiveTabId && !(activeSpaceId in activeTabIds)) {
    activeTabIds[activeSpaceId] = resolvedActiveTabId;
  }

  return {
    spaces,
    activeSpaceId,
    activeTabIds,
    folders: savedFolders,
    tabs: tabs.length ? tabs : fallback.tabs,
    activeTabId: resolvedActiveTabId,
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
        .filter((entry): entry is [string, string] => /^[a-z0-9.-]+$/.test(entry[0]) && v.is(v.string(), entry[1]) && entry[1].startsWith("file://"))
        .slice(-FAVICON_LIMIT),
    ),
    leftAt: v.is(v.number(), value.leftAt) && Number.isFinite(value.leftAt) ? value.leftAt : null,
  };
}

const THEME_CHOICES = ["system", "light", "dark"] as const;

/** Saved preferences with anything unknown or out of range replaced by its default. */
export function parsePreferences(savedPreferences: JsonObject): BrowserPreferences {
  return {
    searchEngineId:
      v.is(v.string(), savedPreferences.searchEngineId) && savedPreferences.searchEngineId
        ? savedPreferences.searchEngineId
        : DEFAULT_PREFERENCES.searchEngineId,
    archiveAfterDays: v.is(v.picklist([0.5, 1, 7, 30]), savedPreferences.archiveAfterDays)
      ? savedPreferences.archiveAfterDays
      : savedPreferences.archiveAfterDays === null
        ? null
        : DEFAULT_PREFERENCES.archiveAfterDays,
    blockContent: v.is(v.boolean(), savedPreferences.blockContent) ? savedPreferences.blockContent : DEFAULT_PREFERENCES.blockContent,
    blockingPausedHosts: Array.isArray(savedPreferences.blockingPausedHosts)
      ? [...new Set(savedPreferences.blockingPausedHosts.filter((host): host is string => v.is(v.string(), host) && /^[a-z0-9.-]+$/.test(host)))]
      : [],
    lockPrivateTabs: savedPreferences.lockPrivateTabs === true,
    reader: parseReaderSettings(savedPreferences.reader),
    hiddenElements: parseHiddenElements(savedPreferences.hiddenElements),
    siteSettings: parseSiteSettings(savedPreferences.siteSettings),
    wallpaper: builtIn(savedPreferences.wallpaper)
      ? savedPreferences.wallpaper
      : savedPreferences.wallpaper === "photo" && isFileUri(savedPreferences.wallpaperPhoto)
        ? "photo"
        : DEFAULT_PREFERENCES.wallpaper,
    wallpaperPhoto: isFileUri(savedPreferences.wallpaperPhoto) ? savedPreferences.wallpaperPhoto : null,
    theme: v.is(v.picklist(THEME_CHOICES), savedPreferences.theme) ? savedPreferences.theme : "system",
    textSize:
      v.is(v.number(), savedPreferences.textSize) && savedPreferences.textSize >= TEXT_SIZE.min && savedPreferences.textSize <= TEXT_SIZE.max
        ? Math.round(savedPreferences.textSize / TEXT_SIZE.step) * TEXT_SIZE.step
        : DEFAULT_PREFERENCES.textSize,
    searchSuggestions: savedPreferences.searchSuggestions !== false,
    skipAmp: savedPreferences.skipAmp !== false,
    pullToRefresh: savedPreferences.pullToRefresh !== false,
    startPageAfterHours: START_PAGE_HOURS.find((hours) => hours === savedPreferences.startPageAfterHours) ?? null,
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
  const activeTabIds = Object.fromEntries(Object.entries(data.activeTabIds).filter(([, tabId]) => tabs.some((tab) => tab.id === tabId)));

  return { ...data, tabs, activeTabId, activeTabIds, downloads };
}
