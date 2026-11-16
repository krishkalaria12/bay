// Settings' pages and search (src/settings): every page builds, the search finds a page by its name, a row on it or
// one a page further in, and a row's page opens with its parents under it.
import assert from "node:assert/strict";
import test from "node:test";

import type { MessageKey, MessageParams } from "../src/i18n/index.ts";
import { CATALOG } from "../src/i18n/messages.ts";
import { indexValue, searchEntries, sections, type SettingsContext } from "../src/settings/content.ts";
import { INDEX, matchSettings, pathTo, PARENT, SETTINGS_PAGES as PAGES } from "../src/settings/model.ts";
import { DEFAULT_PREFERENCES } from "../src/store/model.ts";

function translator(locale: keyof typeof CATALOG) {
  return (key: MessageKey, params: MessageParams = {}) => (CATALOG[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

function context(overrides: Partial<SettingsContext> = {}): SettingsContext {
  const noop = () => undefined;

  return {
    t: translator("en"),
    platform: "ios",
    version: "1.0.0",
    prefs: DEFAULT_PREFERENCES,
    change: noop,
    engines: [
      { id: "google", name: "Google" },
      { id: "duckduckgo", name: "DuckDuckGo" },
    ],
    engineId: "google",
    customEngineId: "custom",
    customSearchUrl: null,
    chooseEngine: noop,
    archiveAfterDays: 7,
    setArchiveAfterDays: noop,
    blockContent: true,
    blockerDetail: "8 lists active",
    setBlockContent: noop,
    pausedHosts: [],
    resumeBlocking: noop,
    lockPrivateTabs: false,
    setLockPrivateTabs: noop,
    wallpaperName: "Sea mist",
    language: { saved: null, current: "en", device: "en" },
    setLanguage: noop,
    defaultBrowser: "not",
    makeDefault: noop,
    openTabCount: 2,
    exportTabs: noop,
    logins: [],
    forgetLogin: noop,
    clear: { stage: "idle", ask: noop, confirm: noop, keep: noop },
    showWelcome: noop,
    openLink: noop,
    ...overrides,
  };
}

test("every page builds, with unique rows and test ids", () => {
  const ctx = context();

  for (const page of PAGES) {
    const rows = sections(page, ctx).flatMap((section) => section.rows);

    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, `${page}: row ids`);
    assert.equal(new Set(rows.map((row) => row.testID)).size, rows.length, `${page}: test ids`);
  }
});

test("a row that opens a page opens one whose parent is the page it is on", () => {
  const ctx = context();

  for (const page of PAGES) {
    for (const row of sections(page, ctx).flatMap((section) => section.rows)) {
      if (row.kind.type === "page") assert.equal(PARENT[row.kind.page], page, `${page} → ${row.kind.page}`);
    }
  }
});

test("the search finds a page by its name first", () => {
  const ctx = context();
  const [first] = matchSettings("appearance", searchEntries(ctx));

  assert.deepEqual(first?.entry, { type: "page", page: "appearance" });
  assert.equal(first?.row, undefined);
});

test("the search finds the row, not just its page, and a page one further in", () => {
  const ctx = context();
  const dark = matchSettings("dark", searchEntries(ctx)).find((match) => match.row);

  assert.equal(dark?.row, "theme.dark");
  assert.deepEqual(dark?.entry, { type: "page", page: "appearance" });

  const japanese = matchSettings("日本", searchEntries(ctx));

  assert.equal(japanese[0]?.page, "language");
  assert.deepEqual(pathTo("language"), ["general", "language"]);
});

test("the search finds an action by the words it is known by, and nothing for nonsense", () => {
  const ctx = context();

  assert.ok(matchSettings("crash", searchEntries(ctx)).some((match) => match.entry.type === "action" && match.entry.action === "report"));
  assert.deepEqual(matchSettings("zzzz", searchEntries(ctx)), []);
});

test("the search reads each language's own words", () => {
  const ctx = context({ t: translator("de") });

  assert.ok(matchSettings("dunkel", searchEntries(ctx)).some((match) => match.entry.type === "page" && match.entry.page === "appearance"));
});

test("the index says what each entry is set to", () => {
  const ctx = context();
  const counts = { bookmarks: 0, history: 3, downloads: 1, crashes: 0 };
  const values = Object.fromEntries(INDEX.flat().map((entry) => [entry.type === "page" ? entry.page : entry.action, indexValue(entry, ctx, counts)]));

  assert.equal(values.search, "Google");
  assert.equal(values.history, "3 pages");
  assert.equal(values.downloads, "1 file");
  assert.equal(values.bookmarks, undefined);
  assert.equal(values.about, "1.0.0");
});

test("clearing data asks first, then says it is working", () => {
  const ids = (stage: SettingsContext["clear"]["stage"]) =>
    sections("privacy", context({ clear: { stage, ask: () => undefined, confirm: () => undefined, keep: () => undefined } }))
      .flatMap((section) => section.rows)
      .map((row) => row.testID);

  assert.ok(ids("idle").includes("settings-clear-data"));
  assert.ok(ids("confirming").includes("clear-data-confirm"));
  assert.ok(ids("confirming").includes("clear-data-cancel"));
});
