export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  createdAt: number;
  lastVisit: number;
  snapshot: string | null;
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
