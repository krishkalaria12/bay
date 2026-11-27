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
import type { PageEngine } from "@bay/chromium";
import * as v from "valibot";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browserStore";
import { layout } from "../lib/constants";
import { DEFAULT_AWAKE_SITES, normalizeAwakeSites } from "../lib/keptAwakeSites";
import { DEFAULT_SPACE_ID } from "./constants";
import { siteFromInput } from "../lib/siteDomain";
import { normalizeExternalLinkRules, normalizeLinkDestination, type ExternalLinkRule, type LinkDestination } from "../lib/externalLinkRules";

export type SearchEngineId = string;

export type Settings = {
  // This Mac's terminal control permission. Kept out of SYNCED_SETTINGS.
  cliControl: boolean;
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
  // Where the Library opens: in the sidebar, as Arc's does (beside the page), or as a page of its own.
  libraryIn: "sidebar" | "page";
  commandBarPreference: "website" | "search";

  tabLayout: "sidebar" | "top";
  // With tabs on top: the toolbar collapses to a strip while you scroll down (toolbar/AutoHideToolbar.tsx).
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
  // Arc Max's Tidy Tabs: the divider's Tidy button. The sidebar menu and command bar offer it either way.
  tidyTabs: boolean;
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
  // requests. The calendar's is the calendar's own setting (activity/activityStore.ts).
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
  // With one space its name in the sidebar says nothing: this takes the header away until there's a second.
  hideSingleSpaceHeader: boolean;
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

  // Which engine pages open in (store/engines.ts). Only a build with WebKit (macOS) reads these; elsewhere every
  // page is Chromium's. Automatic is Bay's own choice: the default engine, site rules and streaming sites in WebKit.
  engineMode: EngineMode;
  defaultEngine: PageEngine;
  // Site rules, by registrable domain ("figma.com" covers its subdomains): lib/siteDomain.ts.
  siteEngines: Record<string, PageEngine>;
  streamingInWebKit: boolean;
  // What a Chromium page whose protected video won't play does (lib/pageEngines.ts › playInWebKit).
  protectedVideoFallback: "ask" | "move" | "stay";
  // A switch keeps the old page on screen until the new one paints, with its scroll and zoom.
  engineSwitchKeepsPage: boolean;
  // A switch carries the site's cookies and storage to the other engine (lib/engineSiteData.ts).
  engineSwitchCarriesSignIns: boolean;
  webKitFraudWarnings: boolean;
};

export type EngineMode = "automatic" | "chromium" | "webkit";

export type LittleBayShortcut = { key: string; keyCode: number; modifiers: ("control" | "option" | "shift" | "command")[] };

export const DEFAULT_SETTINGS: Settings = {
  cliControl: false,
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
  libraryIn: "sidebar",
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
  // On, as in Arc: it waits for a click.
  tidyTabs: true,
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
  hideSingleSpaceHeader: false,
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
  engineMode: "automatic",
  defaultEngine: "chromium",
  siteEngines: {},
  streamingInWebKit: true,
  // Today's behaviour: the page moves, and the video plays.
  protectedVideoFallback: "move",
  engineSwitchKeepsPage: true,
  engineSwitchCarriesSignIns: true,
  webKitFraudWarnings: true,
};

const EngineSchema = v.picklist(["chromium", "webkit"]);

const ENGINE_SETTING_SCHEMAS = {
  engineMode: v.picklist(["automatic", "chromium", "webkit"]),
  defaultEngine: EngineSchema,
  siteEngines: v.record(v.string(), v.string()),
  streamingInWebKit: v.boolean(),
  protectedVideoFallback: v.picklist(["ask", "move", "stay"]),
  engineSwitchKeepsPage: v.boolean(),
  engineSwitchCarriesSignIns: v.boolean(),
  webKitFraudWarnings: v.boolean(),
} as const;

const ENGINE_SETTINGS = [
  "engineMode",
  "defaultEngine",
  "siteEngines",
  "streamingInWebKit",
  "protectedVideoFallback",
  "engineSwitchKeepsPage",
  "engineSwitchCarriesSignIns",
  "webKitFraudWarnings",
] as const satisfies readonly (keyof typeof ENGINE_SETTING_SCHEMAS)[];

/** Site rules keyed by registrable domain, each Chromium or WebKit; anything else is dropped. */
export function normalizeSiteEngines(value: Readonly<Record<string, string>>): Settings["siteEngines"] {
  const rules: Settings["siteEngines"] = {};

  for (const [input, engine] of Object.entries(value)) {
    const site = siteFromInput(input);

    if (site && v.is(EngineSchema, engine)) rules[site] = engine;
  }

  return rules;
}

/** A patch's engine settings, each valid value kept and any other replaced by `current`'s (saved or synced data
 *  can hold anything). */
export function checkedEngineSettings(patch: Partial<Settings>, current: Settings): Partial<Settings> {
  const checked: Partial<Settings> = {};

  for (const name of ENGINE_SETTINGS) {
    if (!(name in patch)) continue;
    const value = patch[name];

    if (!v.is(ENGINE_SETTING_SCHEMAS[name], value)) Object.assign(checked, { [name]: current[name] });
    else if (name === "siteEngines") checked.siteEngines = normalizeSiteEngines(patch.siteEngines ?? {});
    else Object.assign(checked, { [name]: value });
  }

  return checked;
}

type LegacySettings = Partial<Settings> & {
  defaultProfileId?: string;
  warnBeforeMovingTabsToProfile?: boolean;
  openLinksInHarbor?: boolean;
  harborSize?: [number, number];
  openLinksInSmallYahu?: boolean;
  smallYahuSize?: [number, number];
  // The engine choices taken out on 5 Nov 2026; engineMode and siteEngines replace them, starting afresh.
  pageEngine?: unknown;
  websiteEngines?: unknown;
};

/** Preserve preferences and command bindings saved before profiles became spaces. */
export function restoreSettings(saved: LegacySettings | null = {}): Settings {
  const {
    defaultProfileId,
    warnBeforeMovingTabsToProfile,
    openLinksInHarbor,
    harborSize,
    openLinksInSmallYahu,
    smallYahuSize,
    pageEngine: _pageEngine,
    websiteEngines: _websiteEngines,
    ...current
  } = saved ?? {};

  const settings = { ...DEFAULT_SETTINGS, ...current };

  Object.assign(settings, checkedEngineSettings(current, DEFAULT_SETTINGS));

  if (current.defaultSpaceId === undefined && defaultProfileId) settings.defaultSpaceId = defaultProfileId;

  if (current.warnBeforeMovingTabsToSpace === undefined && v.is(v.boolean(), warnBeforeMovingTabsToProfile)) {
    settings.warnBeforeMovingTabsToSpace = warnBeforeMovingTabsToProfile;
  }

  const externalLinks = openLinksInHarbor ?? openLinksInSmallYahu;

  if (current.openLinksInLittleBay === undefined && v.is(v.boolean(), externalLinks)) settings.openLinksInLittleBay = externalLinks;
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

export function searchUrlPrefix(settings: SearchSettings): string {
  return defaultSearchEngine(settings).url;
}

export function validateCustomEngine(settings: SearchSettings, input: EngineInput, ignoreId?: string): string | null {
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
        ...("externalLinkRules" in patch ? { externalLinkRules: normalizeExternalLinkRules(patch.externalLinkRules) } : undefined),
        ...checkedEngineSettings(patch, s.settings),
        ...("awakeSites" in patch
          ? { awakeSites: Array.isArray(patch.awakeSites) ? normalizeAwakeSites(patch.awakeSites) : s.settings.awakeSites }
          : undefined),
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
      ...(settings.searchEngine === id ? { searchEngine: DEFAULT_SETTINGS.searchEngine } : undefined),
    });
  },
});
