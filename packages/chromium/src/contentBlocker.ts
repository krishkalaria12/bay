import { Cef } from "./native";

export type FilterListCategory = "ads" | "trackers" | "cookies" | "regional" | "annoyances" | "security";

export type FilterList = {
  id: string;
  title: string;
  category: FilterListCategory;
  enabled: boolean;
  defaultOn: boolean;
  filters: number;
};

export type ContentBlockerStats = {
  ready: boolean;
  enabled: boolean;
  networkFilters?: number;
  cosmeticFilters?: number;
  unsupportedFilters?: number;
  parseMs: number;
  lookups: number;
  averageLookupMicros: number;
  maxLookupMicros: number;
};

export type ContentBlockerState = {
  enabled: boolean;
  version: string;
  lists: FilterList[];
  allowedHosts: string[];
  /** Sites the user always visits despite a block on the page itself; their requests are still filtered. */
  allowedPages: string[];
  stats: ContentBlockerStats;
};

export const getContentBlocker = () => Cef.getContentBlocker();
export const setContentBlockerEnabled = (enabled: boolean) => Cef.setContentBlockerEnabled(enabled);
export const setFilterListEnabled = (id: string, enabled: boolean) => Cef.setFilterListEnabled(id, enabled);
export const isContentBlockerAllowed = (host: string) => Cef.isContentBlockerAllowed(host);
/** Visit Anyway on a page the blocker stopped: until the app quits, or kept (`remember`). */
export const setBlockedPageAllowed = (host: string, allowed: boolean, remember: boolean) => Cef.setBlockedPageAllowed(host, allowed, remember);
export const setContentBlockerAllowed = (host: string, allowed: boolean) => Cef.setContentBlockerAllowed(host, allowed);
export const onContentBlockerChange = (listener: (stats: ContentBlockerStats) => void) => Cef.addListener("onContentBlocker", listener);
