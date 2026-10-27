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
import type { PageEngine } from "@bay/nncore";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { layout } from "../lib/constants";
import { DEFAULT_AWAKE_SITES, normalizeAwakeSites } from "../lib/awakeSites";
import { DEFAULT_SPACE_ID } from "./constants";
import { normalizeExternalLinkRules, normalizeLinkDestination, type ExternalLinkRule, type LinkDestination } from "../lib/externalLinkRules";

export type SearchEngineId = string;

export type Settings = {
  warnBeforeQuitting: boolean;
  warnBeforeClosingWindow: boolean;
  restoreSession: boolean;
  // What a window shows when Bay opens: a blank new tab (its tabs waiting in the sidebar), or the tab it showed.
  launchTab: "newTab" | "lastTab";
  searchEngine: SearchEngineId;
  searchShortcutMode: "arc" | "duckduckgo";
  customSearchUrl: string;
  customSearchEngines: CustomSearchEngine[];
  extensionSearchEngines: ExtensionSearchEngine[];
  searchSuggestions: boolean;
  calculatorEnabled: boolean;
  tidyDownloads: boolean;
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
  // Arc Max's "Tidy Tab Titles": suggest a short name for a tab when it is pinned.
  // Off by default; reversible via Reset Name. macOS 26 with Apple Intelligence in Arc;
  // Bay ships a heuristic that runs everywhere.
  tidyTabTitles: boolean;
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
  // Arc's badges on favorites: the count a pinned tile's page puts in its title (lib/unreadBadges.ts).
  unreadBadges: boolean;
  sidebarWidth: number;
  // Which side of the window the sidebar docks on; the page takes the other. The window buttons stay at the top left.
  sidebarPosition: "left" | "right";
  // Holding Option alone slides the hidden sidebar out, as Arc's did (App.tsx › SidebarPeek).
  showSidebarOnOption: boolean;
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
  externalLinkDefault: LinkDestination | null;
  externalLinkRules: ExternalLinkRule[];
  // Arc's Peek: a link a pinned tab or a favourite opens in front shows over its page (store/peeks.ts).
  peekLinksFromPinnedTabs: boolean;
  littleBaySize: [number, number];
  // Little Bay from any app (components/littleBay/access.ts), as Little Arc's: a shortcut (a key's code and its
  // modifiers; null is off) and a menu bar button. Both are this Mac's, off until chosen.
  littleBayShortcut: LittleBayShortcut | null;
  littleBayMenuBarItem: boolean;
  // A Little Bay left alone this long is put away, its page in the Library's archive (littleBay/putAway.ts); null never.
  littleBayPutAwayAfterHours: number | null;

  // Where pages open (store/engines.ts): the default engine, website rules ("https://host[:port]" to an engine), and
  // whether streaming sites open in WebKit, where their protected video plays.
  pageEngine: PageEngine;
  websiteEngines: Record<string, PageEngine>;
  protectedVideoInWebKit: boolean;
};

export type LittleBayShortcut = { key: string; keyCode: number; modifiers: ("control" | "option" | "shift" | "command")[] };

export const DEFAULT_SETTINGS: Settings = {
  warnBeforeQuitting: false,
  warnBeforeClosingWindow: true,
  restoreSession: true,
  launchTab: "newTab",
  searchEngine: "google",
  searchShortcutMode: "arc",
  customSearchUrl: "",
  customSearchEngines: [],
  extensionSearchEngines: [],
  searchSuggestions: true,
  calculatorEnabled: true,
  tidyDownloads: false,
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
  tidyTabTitles: false,
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
  unreadBadges: true,
  sidebarWidth: layout.sidebarWidth,
  sidebarPosition: "left",
  showSidebarOnOption: true,
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
  openLinksInLittleBay: true,
  externalLinkDefault: null,
  externalLinkRules: [],
  peekLinksFromPinnedTabs: true,
  littleBaySize: [900, 640],
  littleBayShortcut: null,
  littleBayMenuBarItem: false,
  // Arc's: six hours.
  littleBayPutAwayAfterHours: 6,
  pageEngine: "chromium",
  websiteEngines: {},
  protectedVideoInWebKit: true,
};

const NO_CUSTOM_ENGINES: CustomSearchEngine[] = [];
const NO_EXTENSION_ENGINES: ExtensionSearchEngine[] = [];
const engineCache = new WeakMap<CustomSearchEngine[], { legacyUrl: string; extension: ExtensionSearchEngine[]; engines: SearchEngine[] }>();

export function searchEngines(settings: Settings): SearchEngine[] {
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

export function controllingSearchExtension(settings: Settings): ExtensionSearchEngine | undefined {
  return controllingExtensionEngine(settings.extensionSearchEngines ?? NO_EXTENSION_ENGINES);
}

export function defaultSearchEngine(settings: Settings): SearchEngine {
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
        ...("externalLinkDefault" in patch
          ? {
              externalLinkDefault: normalizeLinkDestination(patch.externalLinkDefault),
              openLinksInLittleBay: patch.externalLinkDefault ? patch.externalLinkDefault.kind === "littleBay" : s.settings.openLinksInLittleBay,
            }
          : "openLinksInLittleBay" in patch
            ? { externalLinkDefault: null }
            : {}),
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
