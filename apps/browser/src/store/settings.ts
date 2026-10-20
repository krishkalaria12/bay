import {
  allEngines,
  controllingExtensionEngine,
  engineById,
  extensionEngineId,
  makeCustomEngine,
  validateEngine,
  type CustomSearchEngine,
  type EngineInput,
  type ExtensionSearchEngine,
  type SearchEngine,
} from "@bay/core";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { layout } from "../lib/constants";
import { DEFAULT_AWAKE_SITES, normalizeAwakeSites } from "../lib/awakeSites";
import { DEFAULT_SPACE_ID } from "./constants";
import { normalizeExternalLinkRules, type ExternalLinkRule } from "../lib/externalLinkRules";

export type SearchEngineId = string;

export type Settings = {
  warnBeforeQuitting: boolean;
  warnBeforeClosingWindow: boolean;
  restoreSession: boolean;
  // What a window shows when Bay opens: a blank new tab (its tabs waiting in the sidebar), or the tab it showed.
  launchTab: "newTab" | "lastTab";
  searchEngine: SearchEngineId;
  customSearchUrl: string;
  customSearchEngines: CustomSearchEngine[];
  extensionSearchEngines: ExtensionSearchEngine[];
  searchSuggestions: boolean;
  calculatorEnabled: boolean;
  commandBarPreference: "website" | "search";

  tabLayout: "sidebar" | "top";
  // With tabs on top: the toolbar collapses to a strip while you scroll down (components/AutoHideToolbar.tsx).
  hideToolbarWhileScrolling: boolean;
  newTabPosition: "top" | "bottom";
  warnBeforeClosingLastTab: boolean;
  warnBeforeMovingTabsToSpace: boolean;
  tabReorderHaptics: boolean;
  extendWebsiteColor: boolean;
  cmdClickCreatesTabGroup: boolean;
  optShiftClickOpensInGroup: boolean;
  autoGroupMeetingTabs: boolean;
  cleanUpInactiveTabsAfterHours: number | null;
  awakeSites: string[];
  mutedSites: string[];
  neverTranslateSites: Record<string, string[]>;
  // Sites in Developer Mode, by host and port ("localhost:3000"): components/developer/devMode.ts.
  developerSites: string[];
  autoPictureInPicture: boolean;
  // Sites whose videos stay in their page when you leave them (Arc's per-site Picture-in-Picture switch), by host.
  noAutoPictureInPictureSites: string[];
  // Arc's Previews on hover (components/previews): a folder's or group's tabs, Gmail's unread mail, GitHub's pull
  // requests. The calendar's is the calendar's own setting (live/store.ts).
  previewFolders: boolean;
  previewGmail: boolean;
  previewGithub: boolean;
  sidebarWidth: number;
  // Which side of the window the sidebar docks on; the page takes the other. The window buttons stay at the top left.
  sidebarPosition: "left" | "right";
  batterySaver: boolean;
  extensionSidePanelWidth: number;

  showFullUrl: boolean;
  bookmarksBar: "always" | "newTab" | "never";
  hideBookmarksBarImport: boolean;

  appearance: "auto" | "light" | "dark";
  density: "comfortable" | "compact";
  // The window behind the sidebar and the card: a solid colour (as yab and Arc have it), or glass that shows the
  // desktop through.
  windowMaterial: "solid" | "glass";
  addressBar: "toolbar" | "sidebar";

  defaultSpaceId: string;

  shortcuts: Record<string, string[]>;

  openLinksInLittleBay: boolean;
  externalLinkRules: ExternalLinkRule[];
  // Arc's Peek: a link a pinned tab or a favourite opens in front shows over its page (store/peeks.ts).
  peekLinksFromPinnedTabs: boolean;
  littleBaySize: [number, number];
};

export const DEFAULT_SETTINGS: Settings = {
  warnBeforeQuitting: false,
  warnBeforeClosingWindow: true,
  restoreSession: true,
  launchTab: "newTab",
  searchEngine: "google",
  customSearchUrl: "",
  customSearchEngines: [],
  extensionSearchEngines: [],
  searchSuggestions: true,
  calculatorEnabled: true,
  commandBarPreference: "website",
  tabLayout: "sidebar",
  hideToolbarWhileScrolling: true,
  newTabPosition: "top",
  warnBeforeClosingLastTab: true,
  warnBeforeMovingTabsToSpace: true,
  tabReorderHaptics: true,
  extendWebsiteColor: true,
  // Off: ⌘-click opens a plain background tab, as in Chrome and Arc; Settings › Links turns on Dia's grouping.
  cmdClickCreatesTabGroup: false,
  optShiftClickOpensInGroup: true,
  autoGroupMeetingTabs: true,
  // On, as Arc's archive (its default is 12 hours). A saved session keeps its choice.
  cleanUpInactiveTabsAfterHours: 12,
  awakeSites: [...DEFAULT_AWAKE_SITES],
  mutedSites: [],
  neverTranslateSites: {},
  developerSites: [],
  autoPictureInPicture: true,
  noAutoPictureInPictureSites: [],
  previewFolders: true,
  previewGmail: true,
  previewGithub: true,
  sidebarWidth: layout.sidebarWidth,
  sidebarPosition: "left",
  batterySaver: true,
  extensionSidePanelWidth: 360,
  showFullUrl: false,
  bookmarksBar: "never",
  hideBookmarksBarImport: false,
  appearance: "auto",
  density: "comfortable",
  windowMaterial: "solid",
  addressBar: "sidebar",
  defaultSpaceId: DEFAULT_SPACE_ID,
  shortcuts: {},
  openLinksInLittleBay: false,
  externalLinkRules: [],
  peekLinksFromPinnedTabs: true,
  littleBaySize: [900, 640],
};

type LegacySettings = Partial<Settings> & {
  defaultProfileId?: string;
  warnBeforeMovingTabsToProfile?: boolean;
  openLinksInHarbor?: boolean;
  harborSize?: [number, number];
  openLinksInSmallYahu?: boolean;
  smallYahuSize?: [number, number];
};

/** Preserve preferences and command bindings saved before profiles became spaces. */
export function restoreSettings(saved: LegacySettings | null = {}): Settings {
  const { defaultProfileId, warnBeforeMovingTabsToProfile, openLinksInHarbor, harborSize, openLinksInSmallYahu, smallYahuSize, ...current } = saved ?? {};
  const settings = { ...DEFAULT_SETTINGS, ...current };
  if (current.defaultSpaceId === undefined && defaultProfileId) settings.defaultSpaceId = defaultProfileId;
  if (current.warnBeforeMovingTabsToSpace === undefined && typeof warnBeforeMovingTabsToProfile === "boolean") {
    settings.warnBeforeMovingTabsToSpace = warnBeforeMovingTabsToProfile;
  }
  const externalLinks = openLinksInHarbor ?? openLinksInSmallYahu;
  if (current.openLinksInLittleBay === undefined && typeof externalLinks === "boolean") settings.openLinksInLittleBay = externalLinks;
  const size = harborSize ?? smallYahuSize;
  if (current.littleBaySize === undefined && Array.isArray(size) && size.length === 2 && size.every((n) => Number.isFinite(n) && n > 0)) {
    settings.littleBaySize = [...size];
  }
  const shortcuts = { ...settings.shortcuts };
  for (const [legacy, name] of [
    ["newSmallYahu", "newLittleBay"],
    ["newHarbor", "newLittleBay"],
    ["toggleOpenLinksInSmallYahu", "toggleOpenLinksInLittleBay"],
    ["toggleOpenLinksInHarbor", "toggleOpenLinksInLittleBay"],
    ["moveTabToProfile", "moveTabToSpace"],
    ["switchProfile", "switchSpace"],
    ["nextProfile", "nextSpace"],
    ["previousProfile", "previousSpace"],
    ["openProfileMenu", "openSpaceMenu"],
  ] as const) {
    if (shortcuts[legacy] && !shortcuts[name]) shortcuts[name] = shortcuts[legacy]!;
    delete shortcuts[legacy];
  }
  settings.shortcuts = shortcuts;
  return settings;
}

const NO_CUSTOM_ENGINES: CustomSearchEngine[] = [];
const NO_EXTENSION_ENGINES: ExtensionSearchEngine[] = [];
const engineCache = new WeakMap<readonly CustomSearchEngine[], { legacyUrl: string; extension: readonly ExtensionSearchEngine[]; engines: SearchEngine[] }>();

type SearchSettings = Readonly<Pick<Settings, "searchEngine" | "customSearchUrl">> & {
  readonly customSearchEngines: readonly CustomSearchEngine[];
  readonly extensionSearchEngines: readonly ExtensionSearchEngine[];
};

export function searchEngines(settings: SearchSettings): SearchEngine[] {
  const custom = settings.customSearchEngines ?? NO_CUSTOM_ENGINES;
  const extension = settings.extensionSearchEngines ?? NO_EXTENSION_ENGINES;
  const cached = engineCache.get(custom);
  if (cached && cached.legacyUrl === settings.customSearchUrl && cached.extension === extension) return cached.engines;
  const engines = allEngines(custom, extension);
  if (settings.customSearchUrl?.includes("%s")) {
    const at = engines.findIndex((e) => e.extension);
    engines.splice(at < 0 ? engines.length : at, 0, { id: "custom", name: "Custom", keyword: "custom", url: settings.customSearchUrl, custom: true });
  }
  engineCache.set(custom, { legacyUrl: settings.customSearchUrl, extension, engines });
  return engines;
}

export function controllingSearchExtension(settings: Pick<SearchSettings, "extensionSearchEngines">): ExtensionSearchEngine | undefined {
  return controllingExtensionEngine(settings.extensionSearchEngines ?? NO_EXTENSION_ENGINES);
}

export function defaultSearchEngine(settings: SearchSettings): SearchEngine {
  const controlling = controllingSearchExtension(settings);
  return engineById(searchEngines(settings), controlling ? extensionEngineId(controlling.extensionId) : settings.searchEngine);
}

export function searchUrlPrefix(settings: Settings): string {
  return defaultSearchEngine(settings).url;
}

export function validateCustomEngine(settings: Settings, input: EngineInput, ignoreId?: string): string | null {
  return validateEngine(input, searchEngines(settings), ignoreId);
}

export type SettingsSlice = {
  settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  setSearchEngine(id: string): void;
  addCustomEngine(input: EngineInput): { id: string } | { error: string };
  updateCustomEngine(id: string, input: EngineInput): string | null;
  removeCustomEngine(id: string): void;
};

let engineCounter = 0;
const newEngineId = () => `engine-${Date.now().toString(36)}-${(++engineCounter).toString(36)}`;

export const createSettingsSlice: StateCreator<BrowserState, [], [], SettingsSlice> = (set, get) => ({
  settings: DEFAULT_SETTINGS,
  updateSettings(patch) {
    set((s) => ({
      settings: {
        ...s.settings,
        ...patch,
        ...("externalLinkRules" in patch ? { externalLinkRules: normalizeExternalLinkRules(patch.externalLinkRules) } : {}),
        ...("awakeSites" in patch ? { awakeSites: Array.isArray(patch.awakeSites) ? normalizeAwakeSites(patch.awakeSites) : s.settings.awakeSites } : {}),
      },
    }));
  },

  setSearchEngine(id) {
    if (searchEngines(get().settings).some((e) => e.id === id)) get().updateSettings({ searchEngine: id });
  },

  addCustomEngine(input) {
    const { settings } = get();
    const error = validateCustomEngine(settings, input);
    if (error) return { error };
    const engine = makeCustomEngine(input, newEngineId());
    get().updateSettings({ customSearchEngines: [...settings.customSearchEngines, engine] });
    return { id: engine.id };
  },

  updateCustomEngine(id, input) {
    const { settings } = get();
    if (!settings.customSearchEngines.some((e) => e.id === id)) return "This search engine no longer exists.";
    const error = validateCustomEngine(settings, input, id);
    if (error) return error;
    get().updateSettings({ customSearchEngines: settings.customSearchEngines.map((e) => (e.id === id ? makeCustomEngine(input, id) : e)) });
    return null;
  },

  removeCustomEngine(id) {
    const { settings } = get();
    get().updateSettings({
      customSearchEngines: settings.customSearchEngines.filter((e) => e.id !== id),
      ...(settings.searchEngine === id ? { searchEngine: DEFAULT_SETTINGS.searchEngine } : {}),
    });
  },
});
