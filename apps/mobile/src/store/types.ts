import type { ReaderSettings } from "../pagescripts/reader.ts";

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
}

export interface BrowserData {
  tabs: BrowserTab[];
  activeTabId: string;
  history: HistoryEntry[];
  pinnedSites: PinnedSite[];
  archive: ArchivedTab[];
  preferences: BrowserPreferences;
}

export type TabUpdate = Partial<Pick<BrowserTab, "url" | "title" | "favicon" | "lastVisit" | "snapshot">>;

export interface BrowserRepository {
  load(): Promise<unknown | null>;
  save(data: BrowserData): Promise<void>;
}
