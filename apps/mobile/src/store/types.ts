import type { ReaderSettings } from "../pagescripts/reader.ts";

/** A JSON object: what the saved state and page messages are made of. */
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type SpaceColor = "gray" | "blue" | "green" | "orange" | "red" | "violet";

/** One named slice of the browser: spaces keep their own tabs, like desktop's (B21). */
export interface BrowserSpace {
  id: string;
  name: string;
  color: SpaceColor;
}

/** A named group of tabs inside a space. Kept local; sync can map a space with its folders later. */
export interface BrowserFolder {
  id: string;
  spaceId: string;
  name: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  createdAt: number;
  lastVisit: number;
  snapshot: string | null;
  /** Private tabs are never saved, archived or added to history. */
  private?: boolean;
  /** Which space this tab belongs to; the switcher shows one space at a time (B21). */
  spaceId: string;
  /** A folder inside the space, when the tab has been filed into one; null at the space's top level. */
  folderId?: string | null;
}

export interface HistoryEntry {
  url: string;
  title: string;
  favicon: string | null;
  visits: number;
  lastVisit: number;
}

export interface PinnedSite {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
}

export interface ArchivedTab extends BrowserTab {
  closedAt: number;
}

export interface DownloadItem {
  /** The engine's id: a UUID on iOS, the system download id on Android. */
  id: string;
  url: string;
  filename: string;
  state: "downloading" | "finished" | "failed" | "cancelled";
  received: number;
  /** 0 when the size isn't known. */
  total: number;
  /** The saved file, once finished: a file:// URL on iOS, a content:// URI on Android. */
  path?: string;
  error?: string;
  /** Why it isn't moving yet ("Starting…", "Waiting for Wi-Fi"); absent while bytes arrive. */
  waiting?: string;
  startedAt: number;
  /** From a private tab: kept in memory only. */
  private?: boolean;
}

export interface BrowserPreferences {
  searchEngineId: string;
  archiveAfterDays: number | null;
  /** Block ads and trackers with the filter lists. */
  blockContent: boolean;
  /** Sites (hosts) where blocking is paused. */
  blockingPausedHosts: string[];
  /** Ask for Face ID, Touch ID or the device passcode before showing private tabs again. */
  lockPrivateTabs: boolean;
  reader: ReaderSettings;
  /** Element selectors hidden on each host. Private edits stay in memory outside this document. */
  hiddenElements: Record<string, string[]>;
  /** Overrides kept per site (host without www.); a host not in the map follows the global settings. */
  siteSettings: Record<string, SiteSetting>;
  /** The start page's wallpaper: one of Bay's (each follows light and dark mode) or the user's photo. */
  wallpaper: WallpaperId;
  /** The user's photo, copied into the app's documents (a file:// URI). */
  wallpaperPhoto: string | null;
  /** Bay's look: follow the system, or always light or dark. */
  theme: ThemeChoice;
  /** Page zoom in percent (80–200): text and images. */
  textSize: number;
  /** Ask the search engine for suggestions while typing. Off keeps typed text on the device until it's sent. */
  searchSuggestions: boolean;
  /** Open the publisher's page instead of an AMP copy. */
  skipAmp: boolean;
  pullToRefresh: boolean;
  /** Show the start page when Bay comes back after this many hours away; null stays on the last tab. */
  startPageAfterHours: number | null;
  /** What to hide on YouTube, with Brave's lists. */
  youtube: YouTubeCleanup;
}

export type ThemeChoice = "system" | "light" | "dark";

/** What one site keeps instead of the global settings (B12). A host without an entry keeps every global choice. */
export type SiteSetting = {
  /** Page zoom in percent (80–200), or null for the global zoom. */
  textSize: number | null;
  /** Reader opens by itself as each article here finishes loading. */
  reader: boolean;
  /** The site answers with its desktop page: the engine presents itself as a desktop browser. */
  desktopMode: boolean;
};

/** What to hide on YouTube, with Brave's lists. Kept a type alias so it stays assignable to `JsonValue`. */
export type YouTubeCleanup = {
  shorts: boolean;
  suggestions: boolean;
  distractions: boolean;
};

/** Preferences the settings screen changes in one step. */
export const SIMPLE_PREFERENCE_KEYS = ["theme", "textSize", "searchSuggestions", "skipAmp", "pullToRefresh", "startPageAfterHours", "youtube"] as const;

export type SimplePreferences = Pick<BrowserPreferences, (typeof SIMPLE_PREFERENCE_KEYS)[number]>;

export type WallpaperId = "bay" | "dusk" | "forest" | "plain" | "photo";

export interface BrowserData {
  tabs: BrowserTab[];
  /** Every tab is listed in its own space; the switcher shows a space at a time (B21). */
  spaces: BrowserSpace[];
  activeSpaceId: string;
  /** The tab last active in each space; a space reopens where it was left. */
  activeTabIds: Record<string, string>;
  folders: BrowserFolder[];
  activeTabId: string;
  history: HistoryEntry[];
  pinnedSites: PinnedSite[];
  archive: ArchivedTab[];
  /** Newest first. */
  downloads: DownloadItem[];
  preferences: BrowserPreferences;
  /** Each site's icon (host without www.), downloaded once into the app's cache: a file:// URI. */
  favicons: Record<string, string>;
  /** When Bay last went to the background, for "start page after hours away"; null while it hasn't. */
  leftAt: number | null;
}

/** The tab fields an engine update can change. */
export const TAB_UPDATE_FIELDS = ["url", "title", "favicon", "lastVisit", "snapshot"] as const;

export type TabUpdate = Partial<Pick<BrowserTab, (typeof TAB_UPDATE_FIELDS)[number]>>;

export interface BrowserRepository {
  /** The saved document as JSON, or null before anything is saved. */
  load(): Promise<JsonValue | null>;
  save(data: BrowserData): Promise<void>;
}
