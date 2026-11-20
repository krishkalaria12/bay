// Writes fixtures/settings.jsonl: what the Expo app's Settings (apps/mobile/src/settings) shows for a range of states in
// every language: each page's sections and rows, what each row does when tapped, the index's values, and what the search
// finds, each state written once and named by its number. The context's callbacks are spies, so a row's action is recorded as the call it makes. The Rust port
// (crates/bay-core/src/settings) builds the same pages from the same context and must say and do the same.
//   node packages/mobile-core/scripts/settings-vector.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../../../apps/mobile/src");
const { CATALOG } = await import(join(app, "i18n/messages.ts"));
const { LOCALE_IDS } = await import(join(app, "i18n/locales.ts"));
const { indexValue, searchEntries, sections } = await import(join(app, "settings/content.ts"));
const { INDEX, matchSettings, pathTo, SETTINGS_PAGES } = await import(join(app, "settings/model.ts"));
const { DEFAULT_PREFERENCES } = await import(join(app, "store/model.ts"));

const NOW = Date.UTC(2026, 10, 16, 12, 1);

/** The app's own lookup: the locale's words, English behind them, and a placeholder without a value left as written. */
function translator(locale) {
  return (key, params) => {
    const value = CATALOG[locale][key] ?? CATALOG.en[key] ?? key;

    return params ? value.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name]))) : value;
  };
}

const SYNCED = {
  status: "synced",
  lastSyncedAt: Date.UTC(2026, 10, 16, 12),
  devices: [
    { id: "phone", name: "iPhone", lastSeen: null, current: true },
    { id: "mac", name: "MacBook", lastSeen: Date.UTC(2026, 10, 16, 11, 55), current: false },
  ],
  remoteTabs: [{ deviceId: "mac", name: "MacBook", tabs: [{ url: "https://bay.example/", title: "Bay" }] }],
  types: { tabs: true, bookmarks: true, history: true },
};

/** A state as the Rust context takes it (crates/bay-core/src/settings/mod.rs `SettingsContext`). */
function spec(overrides = {}) {
  const { prefs, sync, ...rest } = overrides;

  return {
    locale: "en",
    platform: "ios",
    version: "1.0.0",
    prefs: { ...DEFAULT_PREFERENCES, archiveAfterDays: 7, ...prefs },
    engines: [
      { id: "google", name: "Google" },
      { id: "duckduckgo", name: "DuckDuckGo" },
    ],
    blockerDetail: "8 lists active",
    wallpaperName: "Sea mist",
    appIconName: "Paper",
    language: { saved: null, current: "en", device: "en" },
    defaultBrowser: "not",
    openTabCount: 2,
    logins: [],
    clearStage: "idle",
    sync: { ...SYNCED, ...sync },
    now: NOW,
    ...rest,
  };
}

const SCENARIOS = [
  spec(),
  ...LOCALE_IDS.filter((locale) => locale !== "en").map((locale) => spec({ locale, language: { saved: locale, current: locale, device: "en" } })),
  spec({
    platform: "android",
    defaultBrowser: "default",
    language: { saved: "ja", current: "ja", device: "de" },
    prefs: {
      searchEngineId: "custom",
      customSearchUrl: "https://search.example/?q=%s",
      archiveAfterDays: null,
      blockContent: false,
      blockingPausedHosts: ["news.example", "shop.example"],
      lockPrivateTabs: true,
      theme: "dark",
      swipeToNavigate: "edges",
      appLinks: "browser",
      startPageAfterHours: 4,
      searchSuggestions: false,
      textSize: 120,
      pullToRefresh: false,
      openSearchOnLaunch: true,
      skipAmp: false,
      youtube: { shorts: false, suggestions: true, distractions: false },
    },
    appIconName: null,
    openTabCount: 1,
    logins: [
      { origin: "https://a.example", username: "me@a.example" },
      { origin: "https://b.example", username: "krish" },
    ],
    clearStage: "confirming",
    sync: { status: "off", lastSyncedAt: null, devices: [], remoteTabs: [] },
  }),
  spec({
    platform: "android",
    defaultBrowser: "unknown",
    prefs: { searchEngineId: "duckduckgo", archiveAfterDays: 0.5, startPageAfterHours: 1, swipeToNavigate: "off", theme: "light" },
    openTabCount: 0,
    logins: null,
    clearStage: "busy",
    sync: {
      status: "syncing",
      lastSyncedAt: null,
      devices: [{ id: "old", name: "Old Mac", lastSeen: null, current: false }],
      remoteTabs: [
        {
          deviceId: "mac",
          name: "MacBook",
          tabs: [
            { url: "https://www.example.com/a/b?c", title: "" },
            { url: "http://plain.example", title: "Plain" },
          ],
        },
        { deviceId: "pc", name: "Desktop", tabs: [] },
      ],
      types: { tabs: false, bookmarks: true, history: false },
    },
  }),
  spec({
    locale: "de",
    defaultBrowser: "unavailable",
    prefs: { searchEngineId: "nowhere", archiveAfterDays: 30, startPageAfterHours: 12 },
    clearStage: "failed",
    sync: {
      status: "waiting",
      lastSyncedAt: Date.UTC(2026, 10, 14, 9),
      devices: [{ id: "mac", name: "MacBook", lastSeen: Date.UTC(2026, 10, 16, 9), current: false }],
    },
  }),
  spec({ locale: "hi", prefs: { archiveAfterDays: 1 }, sync: { status: "offline" } }),
  spec({ locale: "pt-BR", platform: "android", prefs: { archiveAfterDays: 3 }, sync: { status: "failed", lastSyncedAt: NOW - 30_000 } }),
];

const COUNTS = [
  { bookmarks: 0, history: 0, downloads: 0, crashes: 0 },
  { bookmarks: 1, history: 1, downloads: 1, crashes: 1 },
  { bookmarks: 5, history: 3, downloads: 2, crashes: 7 },
];

const QUERIES = [
  "appearance",
  "Appearance",
  "dark",
  "日本",
  "crash",
  "zzzz",
  "dunkel",
  "",
  "   ",
  "sync",
  "se",
  "s",
  "the",
  "block",
  "a b",
  "history",
  "google",
  "español",
  "pass",
  "1.0",
  "mac",
  "bay",
  "tabs",
  "export",
  "language",
  "privacy",
  "Datenschutz",
  "apariencia",
  "タブ",
  "इतिहास",
  "youtube shorts",
  "lock",
  "icon",
  "join",
  "default",
  "-",
  "e.g.",
  "Bay!",
];

/** The context the TypeScript pages take: the spec's values, and spies for every callback. */
function context(state, calls) {
  const spy =
    (fn) =>
    (...args) =>
      calls.push({ fn, args });

  return {
    t: translator(state.locale),
    platform: state.platform,
    version: state.version,
    prefs: state.prefs,
    change: spy("change"),
    engines: state.engines,
    engineId: state.prefs.searchEngineId,
    customEngineId: "custom",
    customSearchUrl: state.prefs.customSearchUrl,
    chooseEngine: spy("chooseEngine"),
    archiveAfterDays: state.prefs.archiveAfterDays,
    setArchiveAfterDays: spy("setArchiveAfterDays"),
    blockContent: state.prefs.blockContent,
    blockerDetail: state.blockerDetail,
    setBlockContent: spy("setBlockContent"),
    pausedHosts: state.prefs.blockingPausedHosts,
    resumeBlocking: spy("resumeBlocking"),
    lockPrivateTabs: state.prefs.lockPrivateTabs,
    setLockPrivateTabs: spy("setLockPrivateTabs"),
    wallpaperName: state.wallpaperName,
    appIconName: state.appIconName,
    language: state.language,
    setLanguage: spy("setLanguage"),
    defaultBrowser: state.defaultBrowser,
    makeDefault: spy("makeDefault"),
    openTabCount: state.openTabCount,
    exportTabs: spy("exportTabs"),
    logins: state.logins,
    forgetLogin: spy("forgetLogin"),
    clear: { stage: state.clearStage, ask: spy("clear.ask"), confirm: spy("clear.confirm"), keep: spy("clear.keep") },
    showWelcome: spy("showWelcome"),
    openLink: spy("openLink"),
    sync: {
      view: {
        ...state.sync,
        remoteTabs: state.sync.remoteTabs.map((device) => ({ ...device, tabs: device.tabs.map((tab) => ({ u: tab.url, t: tab.title })) })),
        pairing: null,
      },
      now: state.now,
      syncNow: spy("sync.syncNow"),
      setType: spy("sync.setType"),
      leave: spy("sync.leave"),
      openTab: spy("sync.openTab"),
    },
  };
}

/** The one call `run` makes, or a throw when it makes none or several. */
function call(calls, run) {
  calls.length = 0;
  run();

  if (calls.length !== 1) throw new Error(`a row made ${calls.length} calls`);

  return calls[0];
}

function kind(row, calls) {
  switch (row.kind.type) {
    case "page":
      return { type: "page", page: row.kind.page, checked: row.kind.checked ?? false };
    case "choice":
      return { type: "choice", selected: row.kind.selected, action: call(calls, row.kind.choose) };
    case "toggle":
      return {
        type: "toggle",
        on: row.kind.on,
        whenOn: call(calls, () => row.kind.set(true)),
        whenOff: call(calls, () => row.kind.set(false)),
      };
    case "action":
      return { type: "action", action: call(calls, row.kind.run) };
    case "info":
      return { type: "info" };
  }
}

const optional = (value) => value ?? null;

function plainSections(page, ctx, calls) {
  return sections(page, ctx).map((section) => ({
    id: section.id,
    title: optional(section.title),
    rows: section.rows.map((row) => ({
      id: row.id,
      testID: row.testID,
      label: row.label,
      detail: optional(row.detail),
      value: optional(row.value),
      icon: optional(row.icon),
      danger: row.danger ?? false,
      disabled: row.disabled ?? false,
      kind: kind(row, calls),
    })),
    footer: optional(section.footer),
    footerTestID: optional(section.footerTestID),
  }));
}

const lines = [];

for (const [scenario, state] of SCENARIOS.entries()) {
  lines.push({ fn: "context", scenario, ctx: state });

  const calls = [];
  const ctx = context(state, calls);

  for (const page of SETTINGS_PAGES) lines.push({ fn: "sections", scenario, page, result: plainSections(page, ctx, calls) });

  for (const counts of COUNTS) {
    lines.push({ fn: "indexValues", scenario, counts, result: INDEX.flat().map((entry) => optional(indexValue(entry, ctx, counts))) });
  }

  const entries = searchEntries(ctx);

  lines.push({
    fn: "searchEntries",
    scenario,
    result: entries.map((entry) => ({
      ...entry,
      rows: entry.rows.map((row) => ({ id: row.id, label: row.label, detail: optional(row.detail), value: optional(row.value), page: optional(row.page) })),
    })),
  });

  for (const query of QUERIES) {
    lines.push({
      fn: "matchSettings",
      scenario,
      query,
      result: matchSettings(query, entries).map((match) => ({
        entry: match.entry,
        row: optional(match.row),
        page: optional(match.page),
        detail: optional(match.detail),
        id: match.id,
      })),
    });
  }
}

for (const page of SETTINGS_PAGES) lines.push({ fn: "pathTo", page, result: pathTo(page) });

writeFileSync(join(here, "../fixtures/settings.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

const counts = {};

for (const line of lines) counts[line.fn] = (counts[line.fn] ?? 0) + 1;

console.log(`${lines.length} lines`, counts);
