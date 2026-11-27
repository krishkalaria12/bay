import { Cef } from "./native";

export type FilterListCategory = "ads" | "trackers" | "cookies" | "regional" | "annoyances" | "security" | "custom";

export type FilterList = {
  id: string;
  title: string;
  category: FilterListCategory;
  enabled: boolean;
  defaultOn: boolean;
  filters: number;
  /** A list the person added by URL (category "custom"); My Filters has none. */
  url?: string;
};

/** The person's own rules, a list of their own (Settings › Privacy › My Filters). */
export const MY_FILTERS_ID = "my-filters";

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

/** Whether this build lets the person add lists and write their own filters. */
export const canAddFilterLists = () => !!Cef.addFilterList;

/** Adds a list by URL (http or https) and turns it on, once the engine has it: its id. Rejects when it isn't a list or
 *  couldn't be downloaded. */
export const addFilterList = (url: string, title = "") => Cef.addFilterList?.(url, title) ?? Promise.reject(new Error("unavailable"));
export const removeFilterList = (id: string) => Cef.removeFilterList?.(id) ?? Promise.resolve();
export const getUserFilters = () => Cef.getUserFilters?.() ?? Promise.resolve("");
export const setUserFilters = (text: string) => Cef.setUserFilters?.(text) ?? Promise.reject(new Error("unavailable"));

/** Visit Anyway on a page the blocker stopped: until the app quits, or kept (`remember`). */
export const setBlockedPageAllowed = (host: string, allowed: boolean, remember: boolean) => Cef.setBlockedPageAllowed(host, allowed, remember);
export const setContentBlockerAllowed = (host: string, allowed: boolean) => Cef.setContentBlockerAllowed(host, allowed);
export const onContentBlockerChange = (listener: (stats: ContentBlockerStats) => void) => Cef.addListener("onContentBlocker", listener);
