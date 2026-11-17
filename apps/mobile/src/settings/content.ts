// What each page of Settings says: its name, its line, the words it's found by, its tile on the index, and its sections
// of rows, built from plain values and callbacks so the words can be checked without a screen (tests/settings.test.ts).
// Yab's pages (SettingsContent.swift) with Bay's settings in them.

import type { IconName } from "../chrome/Icon.types.ts";
import type { MessageKey, Translate } from "../i18n/index.ts";
import { LOCALE_IDS, LOCALE_NAMES, type Locale } from "../i18n/locales.ts";
import { START_PAGE_HOURS } from "../store/model.ts";
import type { AppLinks, SimplePreferences, SwipeMode, ThemeChoice } from "../store/types.ts";
import type { IndexAction, IndexEntry, SearchEntry, SettingsPage, SettingsRow, SettingsSection } from "./model.ts";
import { INDEX } from "./model.ts";
import type { SyncTypes } from "../sync/engine.ts";
import type { SyncStatus, SyncView } from "../sync/state.ts";

/** The colours of the index's tiles, white glyphs on them, one per kind of page (as iOS Settings has them). */
export const TILE = {
  grey: "#8E8E93",
  blue: "#3478F6",
  pink: "#D9488F",
  orange: "#F08C2E",
  indigo: "#5E5CE6",
  red: "#E5484D",
  amber: "#F29A1F",
  purple: "#8B5CF6",
  green: "#34A853",
  teal: "#1E9AAE",
} as const;

/** An index entry's tile: its glyph on a colour, or Bay's own icon. */
export type Tile = { icon: IconName; tint: string } | { icon: "mark" };

interface EntryInfo {
  title: MessageKey;
  keywords: MessageKey;
  tile: Tile;
}

/** The index's entries: what each is called, the words it is found by and its tile. */
export const ENTRIES: Record<Exclude<SettingsPage, SubPage> | IndexAction, EntryInfo> = {
  general: { title: "settings.page.general", keywords: "settings.keywords.general", tile: { icon: "settings", tint: TILE.grey } },
  search: { title: "settings.page.search", keywords: "settings.keywords.search", tile: { icon: "search", tint: TILE.blue } },
  appearance: { title: "settings.appearance", keywords: "settings.keywords.appearance", tile: { icon: "palette", tint: TILE.pink } },
  tabs: { title: "settings.page.tabs", keywords: "settings.keywords.tabs", tile: { icon: "tabs", tint: TILE.orange } },
  sync: { title: "settings.page.sync", keywords: "settings.keywords.sync", tile: { icon: "sync", tint: TILE.green } },
  privacy: { title: "settings.privacy", keywords: "settings.keywords.privacy", tile: { icon: "lock", tint: TILE.indigo } },
  passwords: { title: "settings.page.passwords", keywords: "settings.keywords.passwords", tile: { icon: "key", tint: TILE.grey } },
  youtube: { title: "settings.group.youtube", keywords: "settings.keywords.youtube", tile: { icon: "video", tint: TILE.red } },
  about: { title: "settings.about", keywords: "settings.keywords.about", tile: { icon: "mark" } },
  bookmarks: { title: "settings.bookmarks", keywords: "settings.keywords.bookmarks", tile: { icon: "bookmark", tint: TILE.amber } },
  history: { title: "settings.history", keywords: "settings.keywords.history", tile: { icon: "history", tint: TILE.purple } },
  downloads: { title: "settings.downloads", keywords: "settings.keywords.downloads", tile: { icon: "download", tint: TILE.blue } },
  import: { title: "settings.import", keywords: "settings.keywords.import", tile: { icon: "import", tint: TILE.green } },
  report: { title: "settings.reportProblem", keywords: "settings.keywords.report", tile: { icon: "error", tint: TILE.orange } },
};

/** Whether a page has an entry of its own on the index. */
export function isIndexPage(page: SettingsPage): page is Exclude<SettingsPage, SubPage> {
  return page in ENTRIES;
}

/** The pages that open from a row on another page rather than from the index. */
type SubPage =
  | "defaultBrowser"
  | "language"
  | "swipe"
  | "appLinks"
  | "customEngine"
  | "wallpaper"
  | "appIcon"
  | "textSize"
  | "archive"
  | "startPage"
  | "syncJoin"
  | "syncPhrase";

/** A page's name, as its header and the head say it. */
export const PAGE_TITLE: Record<SettingsPage, MessageKey> = {
  general: "settings.page.general",
  search: "settings.page.search",
  appearance: "settings.appearance",
  tabs: "settings.page.tabs",
  sync: "settings.page.sync",
  privacy: "settings.privacy",
  passwords: "settings.page.passwords",
  youtube: "settings.group.youtube",
  about: "settings.about",
  defaultBrowser: "settings.defaultBrowser",
  language: "settings.language",
  swipe: "settings.swipe",
  appLinks: "settings.appLinks",
  customEngine: "settings.page.customEngine",
  wallpaper: "settings.wallpaper",
  appIcon: "settings.group.appIcon",
  textSize: "settings.pageZoom",
  archive: "settings.archiveInactive",
  startPage: "settings.startPageAfter",
  syncJoin: "settings.page.syncJoin",
  syncPhrase: "settings.page.syncPhrase",
};

/** A page's one line under its name; the pages a row opens have none, as in Yab. */
export const PAGE_BLURB: Partial<Record<SettingsPage, MessageKey>> = {
  general: "settings.blurb.general",
  search: "settings.blurb.search",
  appearance: "settings.blurb.appearance",
  tabs: "settings.blurb.tabs",
  sync: "settings.blurb.sync",
  privacy: "settings.blurb.privacy",
  passwords: "settings.blurb.passwords",
  youtube: "settings.blurb.youtube",
  about: "settings.blurb.about",
  defaultBrowser: "settings.blurb.defaultBrowser",
};

/** A page's tile in its header: the index's, or the row's glyph for a page a row opens. */
export function pageTile(page: SettingsPage): Tile | null {
  if (isIndexPage(page)) return ENTRIES[page].tile;

  if (page === "defaultBrowser") return { icon: "globe", tint: TILE.blue };

  return null;
}

/** Pages that draw their own body below their sections (a field, the wallpapers, the app icons, the zoom's preview). */
export const DRAWN_PAGES: readonly SettingsPage[] = ["customEngine", "wallpaper", "appIcon", "textSize", "syncJoin", "syncPhrase"];

export const ARCHIVE_OPTIONS: readonly { days: number | null; label: MessageKey; short: MessageKey }[] = [
  { days: 0.5, label: "settings.archive.halfDay", short: "settings.archive.halfDayShort" },
  { days: 1, label: "settings.archive.oneDay", short: "settings.archive.oneDayShort" },
  { days: 7, label: "settings.archive.week", short: "settings.archive.weekShort" },
  { days: 30, label: "settings.archive.month", short: "settings.archive.monthShort" },
  { days: null, label: "settings.archive.never", short: "settings.archive.never" },
];

export const THEMES: readonly { id: ThemeChoice; label: MessageKey }[] = [
  { id: "system", label: "settings.theme.system" },
  { id: "light", label: "settings.theme.light" },
  { id: "dark", label: "settings.theme.dark" },
];

export const SWIPE_MODES: readonly { id: SwipeMode; label: MessageKey }[] = [
  { id: "anywhere", label: "settings.swipe.anywhere" },
  { id: "edges", label: "settings.swipe.edges" },
  { id: "off", label: "settings.swipe.off" },
];

const APP_LINKS: readonly { id: AppLinks; label: MessageKey }[] = [
  { id: "app", label: "settings.appLinks.app" },
  { id: "browser", label: "settings.appLinks.browser" },
];

/** The software Bay is built from, and the licence each ships under (R4). Names and licences stay as their projects write them. */
export const CREDITS: readonly { name: string; licence: string; url: string; android?: boolean }[] = [
  { name: "Bay", licence: "Apache-2.0", url: "https://github.com/krishkalaria12/bay" },
  { name: "Cra", licence: "MIT · © 2026 Victor Kildahl", url: "https://github.com/VictorKildahl/cra" },
  { name: "Yab", licence: "Apache-2.0 · © 2026 Serafim Korablev", url: "https://github.com/yetanotherbrowser/yab" },
  { name: "Chromium", licence: "BSD-3-Clause", url: "https://www.chromium.org/", android: true },
  { name: "adblock-rust", licence: "MPL-2.0", url: "https://github.com/brave/adblock-rust" },
  { name: "uBlock Origin", licence: "GPL-3.0", url: "https://github.com/gorhill/uBlock" },
  { name: "brave/adblock-resources", licence: "MPL-2.0", url: "https://github.com/brave/adblock-resources" },
  { name: "EasyList, EasyPrivacy", licence: "GPL-3.0 / CC BY-SA 3.0", url: "https://easylist.to/" },
  { name: "Peter Lowe's list", licence: "pgl.yoyo.org", url: "https://pgl.yoyo.org/adservers/" },
  { name: "React Native, Expo", licence: "MIT", url: "https://github.com/expo/expo" },
  { name: "HeroUI Native", licence: "MIT", url: "https://github.com/heroui-inc/heroui-native" },
  { name: "Material Symbols", licence: "Apache-2.0", url: "https://github.com/google/material-design-icons", android: true },
  { name: "Inter", licence: "OFL-1.1", url: "https://github.com/rsms/inter", android: true },
  { name: "Caveat", licence: "OFL-1.1", url: "https://github.com/googlefonts/caveat" },
];

export const SOURCE_URL = "https://github.com/krishkalaria12/bay";
export const ISSUES_URL = "https://github.com/krishkalaria12/bay/issues";

/** A saved sign-in, as the Passwords page lists it. */
export interface Login {
  origin: string;
  username: string;
}

/** Where clearing all browsing data is: not asked, asked, running, or failed. */
export type ClearStage = "idle" | "confirming" | "busy" | "failed";

/** Everything Settings shows and changes, as plain values and callbacks. */
export interface SettingsContext {
  t: Translate;
  platform: "ios" | "android";
  version: string;
  prefs: SimplePreferences;
  change: (update: Partial<SimplePreferences>) => void;
  engines: readonly { id: string; name: string }[];
  engineId: string;
  /** The custom engine's id, chosen from its own page. */
  customEngineId: string;
  customSearchUrl: string | null;
  chooseEngine: (id: string) => void;
  archiveAfterDays: number | null;
  setArchiveAfterDays: (days: number | null) => void;
  blockContent: boolean;
  blockerDetail: string;
  setBlockContent: (on: boolean) => void;
  pausedHosts: readonly string[];
  resumeBlocking: (host: string) => void;
  lockPrivateTabs: boolean;
  setLockPrivateTabs: (on: boolean) => void;
  /** The wallpaper's name, said on its row. */
  wallpaperName: string;
  /** The home screen icon's name, said on its row; null where the phone can't change it. */
  appIconName: string | null;
  /** The language Bay was told to use (null follows the phone), the one it uses, and the phone's. */
  language: { saved: Locale | null; current: Locale; device: Locale };
  setLanguage: (locale: Locale | null) => void;
  /** Whether Bay is the default browser, as far as the phone says. */
  defaultBrowser: "default" | "not" | "unknown" | "unavailable";
  makeDefault: () => void;
  openTabCount: number;
  exportTabs: () => void;
  /** The saved sign-ins; null while they load. */
  logins: readonly Login[] | null;
  forgetLogin: (login: Login) => void;
  clear: { stage: ClearStage; ask: () => void; confirm: () => void; keep: () => void };
  showWelcome: () => void;
  openLink: (url: string) => void;
  sync: SyncSettings;
}

/** Sync with the other devices (src/sync): what it says, and what its rows do. */
export interface SyncSettings {
  view: SyncView;
  now: number;
  syncNow: () => void;
  setType: (type: keyof SyncTypes, on: boolean) => void;
  leave: () => void;
  /** Opens another device's tab here. */
  openTab: (url: string) => void;
}

/** What the index says under an entry's name: the setting it is on, or how many there are. */
export interface IndexCounts {
  bookmarks: number;
  history: number;
  downloads: number;
  crashes: number;
}

export function indexValue(entry: IndexEntry, ctx: SettingsContext, counts: IndexCounts): string | undefined {
  const { t } = ctx;
  const count = (n: number, one: string, many: string) => (n ? (n === 1 ? one : many) : undefined);

  if (entry.type === "action") {
    switch (entry.action) {
      case "bookmarks":
        return count(counts.bookmarks, t("bookmarks.folderOne"), t("bookmarks.folderCount", { count: counts.bookmarks }));
      case "history":
        return count(counts.history, t("settings.historyOnePage"), t("settings.historyPages", { count: counts.history }));
      case "downloads":
        return count(counts.downloads, t("settings.downloadsOneFile"), t("settings.downloadsFiles", { count: counts.downloads }));
      case "report":
        return counts.crashes
          ? counts.crashes === 1
            ? t("settings.reportProblem.oneError")
            : t("settings.reportProblem.errors", { count: counts.crashes })
          : t("settings.reportProblem.detail");
      case "import":
        return undefined;
    }
  }

  switch (entry.page) {
    case "search":
      return engineName(ctx);
    case "appearance":
      return t(THEMES.find((theme) => theme.id === ctx.prefs.theme)?.label ?? "settings.theme.system");
    case "privacy":
      return ctx.pausedHosts.length ? t("settings.paused.count", { count: ctx.pausedHosts.length }) : ctx.blockContent ? t("settings.blockContent") : undefined;
    case "about":
      return ctx.version;
    case "sync":
      return ctx.sync.view.status === "off" ? undefined : syncStatusText(ctx.sync.view.status, ctx.t);
    default:
      return undefined;
  }
}

function engineName(ctx: SettingsContext): string | undefined {
  return ctx.engineId === ctx.customEngineId ? ctx.t("settings.customEngine") : ctx.engines.find((engine) => engine.id === ctx.engineId)?.name;
}

function defaultValue(ctx: SettingsContext): string | undefined {
  if (ctx.defaultBrowser === "default") return ctx.t("settings.default.yes");

  return ctx.defaultBrowser === "not" ? ctx.t("settings.default.no") : undefined;
}

/** Under the default browser's state: what it means, or where to make Bay the default. */
function defaultFooter(isDefault: boolean, ctx: SettingsContext): string {
  if (isDefault) return ctx.t("settings.default.isDefault");

  return ctx.platform === "ios" ? ctx.t("settings.default.howIos") : ctx.t("settings.default.howAndroid");
}

function startPageLabel(hours: number | null, t: Translate): string {
  if (hours === null) return t("settings.startPage.never");

  return hours === 1 ? t("settings.startPage.oneHour") : t("settings.startPage.hours", { hours });
}

function toggle(id: string, testID: string, label: string, on: boolean, set: (on: boolean) => void, extra: Partial<SettingsRow> = {}): SettingsRow {
  return { id, testID, label, kind: { type: "toggle", on, set }, ...extra };
}

function choice(id: string, testID: string, label: string, selected: boolean, choose: () => void): SettingsRow {
  return { id, testID, label, kind: { type: "choice", selected, choose } };
}

function opens(id: string, testID: string, label: string, page: SettingsPage, extra: Partial<SettingsRow> = {}): SettingsRow {
  return { id, testID, label, kind: { type: "page", page }, ...extra };
}

/** A page's sections, top to bottom. */
export function sections(page: SettingsPage, ctx: SettingsContext): SettingsSection[] {
  const { t, prefs, change } = ctx;

  switch (page) {
    case "general":
      return [
        {
          id: "browser",
          rows: [
            opens("defaultBrowser", "settings-default-browser", t("settings.defaultBrowser"), "defaultBrowser", { icon: "globe", value: defaultValue(ctx) }),
            opens("language", "settings-language", t("settings.language"), "language", {
              icon: "translate",
              value: ctx.language.saved === null ? t("settings.language.system") : LOCALE_NAMES[ctx.language.current],
            }),
          ],
        },
        {
          id: "moving",
          rows: [
            opens("swipe", "settings-swipe", t("settings.swipe"), "swipe", {
              icon: "back",
              value: t(SWIPE_MODES.find((mode) => mode.id === prefs.swipeToNavigate)?.label ?? "settings.swipe.anywhere"),
            }),
            toggle("pullToRefresh", "settings-pull-refresh", t("settings.pullToRefresh"), prefs.pullToRefresh, (on) => change({ pullToRefresh: on }), {
              icon: "reload",
            }),
            opens("appLinks", "settings-app-links", t("settings.appLinks"), "appLinks", {
              icon: "link",
              value: prefs.appLinks === "app" ? t("settings.appLinks.app") : t("settings.appLinks.browser"),
            }),
          ],
        },
        {
          id: "launch",
          rows: [
            toggle(
              "openSearchOnLaunch",
              "settings-search-on-launch",
              t("settings.searchOnLaunch"),
              prefs.openSearchOnLaunch,
              (on) => change({ openSearchOnLaunch: on }),
              {
                icon: "keyboard",
              },
            ),
          ],
          footer: t("settings.searchOnLaunch.detail"),
        },
        {
          id: "welcome",
          rows: [{ id: "showWelcome", testID: "settings-show-welcome", label: t("settings.showWelcome"), kind: { type: "action", run: ctx.showWelcome } }],
          footer: t("settings.showWelcome.note"),
        },
      ];
    case "search": {
      const custom = ctx.engineId === ctx.customEngineId;
      const name = engineName(ctx) ?? "";

      return [
        {
          id: "engine",
          title: t("settings.searchEngine"),
          rows: [
            ...ctx.engines.map((engine) =>
              choice(`engine.${engine.id}`, `settings-engine-${engine.id}`, engine.name, engine.id === ctx.engineId, () => ctx.chooseEngine(engine.id)),
            ),
            {
              id: "engine.custom",
              testID: "settings-engine-custom",
              label: t("settings.customEngine"),
              detail: ctx.customSearchUrl ?? t("settings.customEngine.detail"),
              kind: { type: "page", page: "customEngine", checked: custom },
            },
          ],
          footer: t("settings.search.engineNote", { engine: name }),
        },
        {
          id: "suggestions",
          rows: [
            toggle("suggestions", "settings-suggestions", t("settings.searchSuggestions"), prefs.searchSuggestions, (on) => change({ searchSuggestions: on })),
          ],
          footer: prefs.searchSuggestions
            ? name
              ? t("settings.searchSuggestions.on", { engine: name })
              : t("settings.searchSuggestions.default")
            : t("settings.searchSuggestions.off"),
        },
      ];
    }

    case "appearance":
      return [
        {
          id: "theme",
          title: t("settings.group.theme"),
          rows: THEMES.map((theme) =>
            choice(`theme.${theme.id}`, `settings-theme-${theme.id}`, t(theme.label), prefs.theme === theme.id, () => change({ theme: theme.id })),
          ),
          footer: t("settings.appearance.note"),
        },
        {
          id: "startPage",
          title: t("settings.group.startPage"),
          rows: [
            opens("wallpaper", "settings-wallpaper", t("settings.wallpaper"), "wallpaper", { icon: "wallpaper", value: ctx.wallpaperName }),
            opens("textSize", "settings-text-size", t("settings.pageZoom"), "textSize", { icon: "textSize", value: `${prefs.textSize}%` }),
          ],
        },
        ...(ctx.appIconName === null
          ? []
          : [
              {
                id: "appIcon",
                rows: [opens("appIcon", "settings-app-icon", t("settings.group.appIcon"), "appIcon", { icon: "mark", value: ctx.appIconName })],
                footer: t("settings.appIcon.note"),
              },
            ]),
      ];
    case "tabs": {
      const archive = ARCHIVE_OPTIONS.find((option) => option.days === ctx.archiveAfterDays);

      const sectionsHere: SettingsSection[] = [
        {
          id: "quiet",
          rows: [
            opens("archive", "settings-archive", t("settings.archiveInactive"), "archive", { icon: "archive", value: archive ? t(archive.short) : undefined }),
            opens("startPage", "settings-start-page", t("settings.startPageAfter"), "startPage", {
              icon: "history",
              value:
                prefs.startPageAfterHours === null ? t("settings.startPage.never") : t("settings.startPage.hoursAway", { hours: prefs.startPageAfterHours }),
            }),
          ],
        },
      ];

      if (ctx.openTabCount) {
        sectionsHere.push({
          id: "export",
          rows: [
            { id: "export", testID: "settings-export-tabs", icon: "share", label: t("settings.exportTabs"), kind: { type: "action", run: ctx.exportTabs } },
          ],
          footer: ctx.openTabCount === 1 ? t("settings.exportTabs.one") : t("settings.exportTabs.count", { count: ctx.openTabCount }),
        });
      }

      return sectionsHere;
    }

    case "privacy":
      return privacy(ctx);
    case "passwords":
      return [
        {
          id: "saved",
          title: ctx.logins?.length ? t("settings.group.passwords") : undefined,
          rows: ctx.logins?.length
            ? ctx.logins.map((login) => ({
                id: `login.${login.origin}.${login.username}`,
                testID: `saved-login-${login.origin}-${login.username}`,
                icon: "key" as const,
                label: login.username,
                detail: login.origin,
                value: t("settings.passwords.delete"),
                danger: true,
                kind: { type: "action" as const, run: () => ctx.forgetLogin(login) },
              }))
            : [{ id: "none", testID: "settings-passwords-none", icon: "key", label: t("settings.passwords.none"), kind: { type: "info" } }],
          footer: t("settings.passwords.note"),
        },
      ];
    case "youtube": {
      const youtube = prefs.youtube;

      return [
        {
          id: "youtube",
          rows: [
            toggle("shorts", "settings-yt-shorts", t("settings.youtube.shorts"), youtube.shorts, (on) => change({ youtube: { ...youtube, shorts: on } })),
            toggle(
              "suggestions",
              "settings-yt-suggestions",
              t("settings.youtube.suggestions"),
              youtube.suggestions,
              (on) => change({ youtube: { ...youtube, suggestions: on } }),
              {
                detail: t("settings.youtube.suggestionsDetail"),
              },
            ),
            toggle(
              "distractions",
              "settings-yt-distractions",
              t("settings.youtube.distractions"),
              youtube.distractions,
              (on) => change({ youtube: { ...youtube, distractions: on } }),
              { detail: t("settings.youtube.distractionsDetail") },
            ),
          ],
          footer: t("settings.youtube.note"),
        },
      ];
    }

    case "about":
      return [
        {
          id: "bay",
          rows: [{ id: "version", testID: "settings-about-version", icon: "mark", label: "Bay", value: ctx.version, kind: { type: "info" } }],
          footer: t("settings.about.privacy"),
          footerTestID: "settings-about-privacy",
        },
        {
          id: "links",
          rows: [
            {
              id: "source",
              testID: "settings-about-source",
              icon: "link",
              label: t("settings.about.source"),
              detail: SOURCE_URL.replace("https://", ""),
              kind: { type: "action", run: () => ctx.openLink(SOURCE_URL) },
            },
            {
              id: "issue",
              testID: "settings-about-issues",
              icon: "error",
              label: t("settings.about.issue"),
              detail: t("settings.about.issueDetail"),
              kind: { type: "action", run: () => ctx.openLink(ISSUES_URL) },
            },
          ],
        },
        {
          id: "licences",
          title: t("settings.group.licences"),
          rows: CREDITS.flatMap((credit): SettingsRow[] =>
            credit.android && ctx.platform !== "android"
              ? []
              : [
                  {
                    id: `credit.${credit.name}`,
                    testID: `settings-credit-${credit.name}`,
                    label: credit.name,
                    detail: credit.licence,
                    kind: { type: "action", run: () => ctx.openLink(credit.url) },
                  },
                ],
          ),
          footer: t("settings.about.licencesNote"),
        },
      ];
    case "defaultBrowser": {
      const isDefault = ctx.defaultBrowser === "default";

      return [
        {
          id: "state",
          rows: [
            {
              id: "state",
              testID: "settings-default-state",
              icon: "globe",
              label: t("settings.defaultBrowser"),
              value: defaultValue(ctx),
              kind: { type: "info" },
            },
          ],
          footer: defaultFooter(isDefault, ctx),
        },
        {
          id: "open",
          rows: [
            {
              id: "open",
              testID: "default-browser-open",
              label: ctx.platform === "android" && !isDefault ? t("settings.default.make") : t("default.open"),
              kind: { type: "action", run: ctx.makeDefault },
            },
          ],
        },
      ];
    }

    case "language":
      return [
        {
          id: "language",
          rows: [
            {
              ...choice("system", "settings-language-system", t("settings.language.system"), ctx.language.saved === null, () => ctx.setLanguage(null)),
              detail: t("settings.language.systemDetail", { language: LOCALE_NAMES[ctx.language.device] }),
            },
            ...LOCALE_IDS.map((locale) =>
              choice(locale, `settings-language-${locale}`, LOCALE_NAMES[locale], ctx.language.saved === locale, () => ctx.setLanguage(locale)),
            ),
          ],
        },
      ];
    case "swipe":
      return [
        {
          id: "swipe",
          rows: SWIPE_MODES.map((mode) =>
            choice(mode.id, `settings-swipe-${mode.id}`, t(mode.label), prefs.swipeToNavigate === mode.id, () => change({ swipeToNavigate: mode.id })),
          ),
          footer: t("settings.swipe.note"),
        },
      ];
    case "appLinks":
      return [
        {
          id: "appLinks",
          rows: APP_LINKS.map((option) =>
            choice(option.id, `settings-app-links-${option.id}`, t(option.label), prefs.appLinks === option.id, () => change({ appLinks: option.id })),
          ),
          footer: t("settings.appLinks.note"),
        },
      ];
    case "archive":
      return [
        {
          id: "archive",
          rows: ARCHIVE_OPTIONS.map((option) =>
            choice(String(option.days ?? "never"), `settings-archive-${option.days ?? "never"}`, t(option.label), ctx.archiveAfterDays === option.days, () =>
              ctx.setArchiveAfterDays(option.days),
            ),
          ),
          footer: t("settings.archive.note"),
        },
      ];
    case "startPage":
      return [
        {
          id: "startPage",
          rows: START_PAGE_HOURS.map((hours) =>
            choice(String(hours ?? "never"), `settings-start-page-${hours ?? "never"}`, startPageLabel(hours, t), prefs.startPageAfterHours === hours, () =>
              change({ startPageAfterHours: hours }),
            ),
          ),
          footer: t("settings.startPage.note"),
        },
      ];
    case "sync":
      return sync(ctx);
    case "customEngine":
    case "wallpaper":
    case "appIcon":
    case "textSize":
    case "syncJoin":
    case "syncPhrase":
      return [];
  }
}

function privacy(ctx: SettingsContext): SettingsSection[] {
  const { t, prefs, change, clear } = ctx;
  const busy = clear.stage === "busy";

  const result: SettingsSection[] = [
    {
      id: "blocking",
      rows: [
        toggle("blockContent", "settings-block-content", t("settings.blockContent"), ctx.blockContent, ctx.setBlockContent, { icon: "shield", disabled: busy }),
      ],
      footer: ctx.blockerDetail,
      footerTestID: "settings-block-content-detail",
    },
  ];

  if (ctx.pausedHosts.length) {
    result.push({
      id: "paused",
      title: t("settings.group.paused"),
      rows: ctx.pausedHosts.map((host) => ({
        id: `paused.${host}`,
        testID: `settings-paused-${host}`,
        label: host,
        value: t("settings.paused.resume"),
        kind: { type: "action", run: () => ctx.resumeBlocking(host) },
      })),
      footer: t("settings.paused.note"),
    });
  }

  result.push(
    {
      id: "amp",
      rows: [toggle("skipAmp", "settings-skip-amp", t("settings.skipAmp"), prefs.skipAmp, (on) => change({ skipAmp: on }), { icon: "link" })],
      footer: t("settings.skipAmp.detail"),
    },
    {
      id: "private",
      rows: [toggle("lockPrivate", "settings-lock-private", t("settings.lockPrivate"), ctx.lockPrivateTabs, ctx.setLockPrivateTabs, { icon: "private" })],
      footer: t("settings.lockPrivate.detail"),
    },
    {
      id: "data",
      rows:
        clear.stage === "idle"
          ? [
              {
                id: "clearData",
                testID: "settings-clear-data",
                icon: "delete",
                label: t("settings.clearData"),
                danger: true,
                kind: { type: "action", run: clear.ask },
              },
            ]
          : [
              {
                id: "clearData",
                testID: "clear-data-confirm",
                icon: "delete",
                label: busy ? t("settings.clearingData") : t("settings.clearAllData"),
                danger: true,
                disabled: busy,
                kind: { type: "action", run: clear.confirm },
              },
              { id: "keepData", testID: "clear-data-cancel", label: t("settings.keepData"), disabled: busy, kind: { type: "action", run: clear.keep } },
            ],
      ...clearFooter(clear.stage, t),
    },
  );

  return result;
}

/** What clearing says under its rows: what it clears, that it is running, or that it failed. */
function clearFooter(stage: ClearStage, t: Translate): Pick<SettingsSection, "footer" | "footerTestID"> {
  switch (stage) {
    case "busy":
      return { footer: t("settings.clearingWebsiteData"), footerTestID: "clear-data-busy" };
    case "failed":
      return { footer: t("settings.clearDataFailed"), footerTestID: "clear-data-error" };
    default:
      return { footer: t("settings.clearAllData.detail") };
  }
}

const SYNC_STATUS: Record<SyncStatus, MessageKey> = {
  off: "sync.notYet",
  syncing: "sync.status.syncing",
  synced: "sync.status.synced",
  waiting: "sync.status.waiting",
  offline: "sync.status.offline",
  failed: "sync.status.failed",
};

export const syncStatusText = (status: SyncStatus, t: Translate): string => t(SYNC_STATUS[status]);

/** "Synced 5 min ago", and the like. */
export function syncedAgo(at: number, now: number, t: Translate): string {
  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) return t("sync.justNow");

  if (minutes < 60) return t("sync.minutesAgo", { count: minutes });

  if (minutes < 60 * 24) return t("sync.hoursAgo", { count: Math.floor(minutes / 60) });

  return t("sync.daysAgo", { count: Math.floor(minutes / (60 * 24)) });
}

const SYNC_TYPES: readonly { type: keyof SyncTypes; label: MessageKey; icon: IconName }[] = [
  { type: "tabs", label: "sync.type.tabs", icon: "tabs" },
  { type: "bookmarks", label: "sync.type.bookmarks", icon: "bookmark" },
  { type: "history", label: "sync.type.history", icon: "history" },
];

/** The host a tab's row says under its title. */
const hostOf = (url: string) =>
  url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");

function sync(ctx: SettingsContext): SettingsSection[] {
  const { t } = ctx;
  const { view, now } = ctx.sync;

  if (view.status === "off") {
    return [
      {
        id: "join",
        rows: [
          { id: "joinCode", testID: "sync-join-code", icon: "desktop", label: t("sync.join.code"), kind: { type: "page", page: "syncJoin" } },
          { id: "joinPhrase", testID: "sync-join-phrase", icon: "key", label: t("sync.join.phrase"), kind: { type: "page", page: "syncPhrase" } },
        ],
        footer: t("sync.join.note"),
      },
    ];
  }

  const result: SettingsSection[] = [
    {
      id: "status",
      rows: [
        {
          id: "status",
          testID: "sync-status",
          icon: "sync",
          label: t("sync.status"),
          value: syncStatusText(view.status, t),
          detail: view.lastSyncedAt ? syncedAgo(view.lastSyncedAt, now, t) : undefined,
          kind: { type: "info" },
        },
        { id: "now", testID: "sync-now", label: t("sync.now"), disabled: view.status === "syncing", kind: { type: "action", run: ctx.sync.syncNow } },
      ],
    },
  ];

  if (view.devices.length) {
    result.push({
      id: "devices",
      title: t("sync.devices"),
      rows: view.devices.map((device) => ({
        id: `device.${device.id}`,
        testID: `sync-device-${device.id}`,
        label: device.name,
        value: device.current ? t("sync.thisPhone") : device.lastSeen ? syncedAgo(device.lastSeen, now, t) : t("sync.notYet"),
        kind: { type: "info" },
      })),
    });
  }

  for (const device of view.remoteTabs) {
    result.push({
      id: `tabs.${device.deviceId}`,
      title: t("sync.tabsOn", { device: device.name }),
      rows: device.tabs.map((tab, index) => ({
        id: `tab.${device.deviceId}.${index}`,
        testID: `sync-tab-${device.deviceId}-${index}`,
        label: tab.t || hostOf(tab.u),
        detail: hostOf(tab.u),
        kind: { type: "action", run: () => ctx.sync.openTab(tab.u) },
      })),
    });
  }

  result.push(
    {
      id: "what",
      title: t("sync.what"),
      rows: SYNC_TYPES.map(({ type, label, icon }) => ({
        id: `type.${type}`,
        testID: `sync-type-${type}`,
        icon,
        label: t(label),
        kind: { type: "toggle", on: view.types[type], set: (on: boolean) => ctx.sync.setType(type, on) },
      })),
      footer: t("sync.what.note"),
    },
    {
      id: "leave",
      rows: [{ id: "leave", testID: "sync-leave", label: t("sync.leave"), danger: true, kind: { type: "action", run: ctx.sync.leave } }],
      footer: t("sync.leave.note"),
    },
  );

  return result;
}

/** Sub-pages whose rows the search reads under their parent's entry. */
const NESTED: Partial<Record<SettingsPage, readonly SettingsPage[]>> = {
  general: ["defaultBrowser", "language", "swipe", "appLinks"],
  tabs: ["archive", "startPage"],
};

/** The index as the search reads it: every entry, with its page's rows and those of the pages a row there opens. */
export function searchEntries(ctx: SettingsContext): SearchEntry[] {
  return INDEX.flat().map((entry) => {
    if (entry.type === "action") {
      const info = ENTRIES[entry.action];

      return { entry, title: ctx.t(info.title), keywords: ctx.t(info.keywords), rows: [] };
    }

    const info = ENTRIES[isIndexPage(entry.page) ? entry.page : "general"];

    const own = sections(entry.page, ctx).flatMap((section) =>
      section.rows.map((row) => ({ id: row.id, label: row.label, detail: row.detail, value: row.value })),
    );

    const nested = (NESTED[entry.page] ?? []).flatMap((sub) =>
      sections(sub, ctx).flatMap((section) => section.rows.map((row) => ({ id: row.id, label: row.label, detail: row.detail, page: sub }))),
    );

    return { entry, title: ctx.t(info.title), keywords: ctx.t(info.keywords), rows: [...own, ...nested] };
  });
}
