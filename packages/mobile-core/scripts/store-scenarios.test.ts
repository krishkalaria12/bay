// Drives the Expo app's store through what its own tests don't reach, so `record-fixtures.mjs store` records those
// calls too: the actions no test uses, and edge cases in names, emoji, rounding and broken saved documents. Each
// call only has to run; the Rust port is checked against what it returned.
import test from "node:test";

import {
  createTab,
  initialBrowserData,
  parseBrowserData,
  parsePreferences,
  parseSiteSetting,
  persistedBrowserData,
  reduceBrowserData,
} from "../../../apps/mobile/src/store/model.ts";
import type { BrowserAction, BrowserData } from "../../../apps/mobile/src/store/types.ts";

const NOW = 1_700_000_000_000;

function run(data: BrowserData, ...actions: BrowserAction[]): BrowserData {
  return actions.reduce((state, action) => reduceBrowserData(state, action), data);
}

function base(): BrowserData {
  let data = initialBrowserData(createTab("t1", NOW, "https://example.com/"));
  data = run(
    data,
    { type: "new-tab", tab: { ...createTab("t2", NOW + 1, "https://news.ycombinator.com/"), title: "HN" }, background: false },
    { type: "create-space", space: { id: "work", name: "Work", color: "green", icon: "💼" }, blankTab: createTab("t3", NOW + 2, "", false, "work") },
    { type: "create-space", space: { id: "fun", name: "Fun", color: "red" }, blankTab: createTab("t4", NOW + 3, "https://youtube.com/", false, "fun") },
    { type: "new-folder", folder: { id: "f1", spaceId: "personal", name: "Reading" } },
    { type: "new-folder", folder: { id: "f2", spaceId: "work", name: "Docs" } },
    { type: "select-space", id: "personal" },
    { type: "pin-site", tabId: "t1", pinId: "p1", kind: "essential" },
    { type: "pin-site", tabId: "t2", pinId: "p2", kind: "row", folderId: "f1" },
    { type: "visit", spaceId: "personal", url: "https://example.com/", title: "Example", favicon: null, now: NOW + 10 },
    { type: "visit", spaceId: "work", url: "https://docs.rs/", title: "Docs", favicon: "file:///icons/docs.png", now: NOW + 11 },
  );

  return data;
}

test("the actions the app's tests don't use", () => {
  const data = base();
  run(
    data,
    {
      type: "import-history",
      entries: [
        { spaceId: "personal", url: "https://example.com/", title: "", favicon: "file:///e.png", visits: 3, lastVisit: NOW - 5 },
        { spaceId: "personal", url: "https://rust-lang.org/", title: "Rust", favicon: null, visits: 2, lastVisit: NOW + 50 },
        { spaceId: "work", url: "ftp://nope/", title: "x", favicon: null, visits: 1, lastVisit: NOW },
        { spaceId: "work", url: "https://zero.example/", title: "x", favicon: null, visits: 0, lastVisit: NOW },
      ],
    },
    { type: "import-history", entries: [] },
  );

  for (const name of ["  Deep work  ", "", "   ", "A name far longer than the forty units a space name may keep, cut", "🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️🏝️"]) {
    run(data, { type: "rename-space", id: "work", name });
  }

  run(data, { type: "rename-space", id: "nowhere", name: "X" });

  for (const icon of ["🚀", "  🧠  ", "", null, "👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "🇯🇵"]) {
    run(data, { type: "set-space-icon", id: "fun", icon });
  }

  run(data, { type: "rename-folder", id: "f1", name: `${"c".repeat(39)}🌱🌱` });
  run(data, { type: "sync-spaces", added: [], changed: [{ id: "work", name: `${"d".repeat(39)}💼`, color: "green", icon: "🇯🇵🇯🇵🇯🇵🇯🇵🇯🇵" }] });

  for (const color of ["violet", "green", "gray"] as const) run(data, { type: "set-space-color", id: "work", color });
  run(data, { type: "set-space-color", id: "nowhere", color: "blue" });

  for (const to of [0, 1, 2, 9, -3]) run(data, { type: "reorder-space", id: "fun", to });
  run(data, { type: "reorder-space", id: "nowhere", to: 0 });

  for (const name of ["Later", "", "  Saved  "]) run(data, { type: "rename-folder", id: "f1", name });
  run(data, { type: "rename-folder", id: "nowhere", name: "X" });
  run(data, { type: "move-pin", id: "p1", kind: "row", folderId: "f1" });
  run(data, { type: "move-pin", id: "p2", kind: "essential", folderId: "f1" });
  run(data, { type: "move-pin", id: "p2", kind: "row", folderId: "missing" });
  run(data, { type: "move-pin", id: "p2", kind: "row", folderId: null });

  for (const days of [null, 0.5, 1, 7, 30, 2]) run(data, { type: "archive-days", days });
  run(data, { type: "lock-private-tabs", enabled: true }, { type: "lock-private-tabs", enabled: true }, { type: "lock-private-tabs", enabled: false });

  const downloading = run(data, {
    type: "download",
    update: { id: "d1", url: "https://example.com/a.zip", filename: "a.zip", state: "started", received: 0, total: 100, private: false },
    now: NOW,
  });

  run(downloading, { type: "remove-download", id: "d1" }, { type: "remove-download", id: "d1" });
});

test("spaces, tabs and pins at their edges", () => {
  const data = base();
  run(data, { type: "delete-space", id: "personal", blankTab: createTab("b1", NOW, "") });
  run(data, { type: "delete-space", id: "work", blankTab: createTab("b2", NOW, "") });
  run(run(data, { type: "select-space", id: "fun" }), { type: "delete-space", id: "fun", blankTab: createTab("b3", NOW, "") });
  run(data, { type: "select-space", id: "work" }, { type: "close-tab", id: "t3", now: NOW, fallback: createTab("b4", NOW, "", false, "work") });
  run(data, { type: "move-tab", id: "t2", spaceId: "work", folderId: "f2" }, { type: "move-tab", id: "t2", spaceId: "work", folderId: "f2" });
  run(data, { type: "move-tab", id: "t2", spaceId: "fun", folderId: null });
  run(data, { type: "pin-site", tabId: "t2", pinId: "p9", kind: "row", folderId: "f1" });
  run(data, { type: "pin-site", tabId: "t2", pinId: "p9", kind: "essential" });
  run(data, { type: "pin-site", tabId: "t3", pinId: "p9", kind: "essential" });
  run(data, {
    type: "add-pin",
    site: { id: "p8", url: "https://a.example/", title: "A", favicon: null, spaceId: "work", kind: "row", folderId: null },
    index: -1,
  });
  run(data, {
    type: "add-pin",
    site: { id: "p7", url: "https://b.example/", title: "B", favicon: null, spaceId: "work", kind: "essential", folderId: null },
    index: 50,
  });
  run(data, { type: "delete-folder", id: "f1" });
  run(data, { type: "close-tab", id: "t1", now: NOW + 100, fallback: createTab("b5", NOW, "") });
  let single = initialBrowserData(createTab("only", NOW, "https://example.com/x"));
  single = run(single, { type: "close-tab", id: "only", now: NOW + 5, fallback: createTab("fresh", NOW + 5, "") });
  run(single, { type: "restore-tab", id: "only", restoredId: "back", now: NOW + 6 });
  run(data, { type: "archive-stale", now: NOW + 30 * 24 * 60 * 60 * 1000 });
  run(
    data,
    { type: "favicon", host: "example.com", uri: "file:///a.png" },
    { type: "favicon", host: "docs.rs", uri: "file:///b.png" },
    { type: "favicon", host: "example.com", uri: "file:///c.png" },
    { type: "favicon", host: "docs.rs", uri: null },
  );
  run(data, { type: "clear-history", spaceId: "work" }, { type: "clear-history" });
  run(
    data,
    { type: "search-engine", id: "custom", customUrl: "  https://search.example/?q=%s  " },
    { type: "search-engine", id: "custom", customUrl: "http://bad/?q=%s" },
  );
  run(
    data,
    { type: "wallpaper", id: "photo" },
    { type: "wallpaper", id: "photo", photo: "file:///me.jpg" },
    { type: "wallpaper", id: "dusk" },
    { type: "wallpaper", id: "photo" },
  );
});

test("settings at their edges", () => {
  const data = base();
  run(
    data,
    { type: "preferences", update: { textSize: 85 } },
    { type: "preferences", update: { textSize: 999 } },
    { type: "preferences", update: { theme: "dark", startPageAfterHours: 4 } },
  );
  // SAFETY: 3 isn't one of the hours Settings offers; the cast feeds the parser a value it must refuse.
  run(
    data,
    { type: "preferences", update: { startPageAfterHours: 3 as 4 } },
    { type: "preferences", update: { youtube: { shorts: true, suggestions: false, distractions: true } } },
  );
  run(
    data,
    { type: "reader-settings", settings: { theme: "sepia", font: "mono", size: 40 } },
    { type: "reader-settings", settings: { theme: "sepia", font: "mono", size: 14.5 } },
  );
  run(data, {
    type: "site-settings",
    host: "WWW.Example.com",
    update: { textSize: 133, reader: true, desktopMode: false, blockOff: ["cookies", "ads", "ads"], swipe: "edges" },
  });
  run(data, { type: "site-settings", host: "example.com", update: { textSize: null, reader: false, desktopMode: false, blockOff: [], swipe: null } });
  run(data, { type: "site-settings", host: "not a host", update: { textSize: 90, reader: false, desktopMode: false, blockOff: [], swipe: null } });
  run(
    data,
    { type: "hidden-elements", host: "Example.com", selectors: [" .ad ", ".ad", "", "#promo"] },
    { type: "hidden-elements", host: "example.com", selectors: [] },
  );
  run(
    data,
    { type: "pause-blocking", host: "WWW.Site.com", paused: true },
    { type: "pause-blocking", host: "site.com", paused: true },
    { type: "pause-blocking", host: "site.com", paused: false },
  );
  run(data, { type: "tip-seen", id: "bar" }, { type: "tip-seen", id: "bar" }, { type: "welcome-again" });
  parsePreferences({
    textSize: 150.4,
    archiveAfterDays: 0.5,
    tipsSeen: ["bar", "x"],
    wallpaper: "photo",
    wallpaperPhoto: "file:///p.jpg",
    blockingPausedHosts: ["a.com", "A.com", "a.com", "b c"],
  });
  parsePreferences({
    archiveAfterDays: null,
    welcomed: false,
    appLinks: "browser",
    swipeToNavigate: "edges",
    customSearchUrl: "https://s.example/%s",
    reader: { theme: "nope", size: 9 },
  });
  parseSiteSetting({ textSize: 205, blockOff: "ads", swipe: "sideways" });
});

test("saved documents, good and broken", () => {
  const fallback = initialBrowserData(createTab("fallback", NOW, ""));
  const saved = JSON.parse(JSON.stringify({ version: 2, ...persistedBrowserData(base()) }));
  parseBrowserData(saved, fallback);
  parseBrowserData(
    {
      ...saved,
      version: 1,
      spaces: undefined,
      folders: [{ id: "x", spaceId: "gone", name: "X" }],
      bookmarks: {
        bookmarks: { kind: "folder", id: "bookmarks", title: "", children: ["a", "a", "b"], addedAt: 0 },
        a: { kind: "url", id: "a", title: "A", url: "https://a.example/", addedAt: 1 },
        b: { kind: "url", id: "b", title: "B", url: "javascript:alert(1)", addedAt: 1 },
      },
    },
    fallback,
  );
  parseBrowserData(
    {
      version: 2,
      tabs: [
        { id: "t", url: "https://x.example/", title: "X", createdAt: 1, lastVisit: 2, snapshot: "http://not-a-file" },
        { id: "t", url: "https://dup.example/", title: "Dup", createdAt: 1, lastVisit: 2 },
      ],
      spaces: [
        { id: "s", name: "", color: "pink", icon: "" },
        { id: "personal", name: "Me" },
      ],
      activeSpaceId: "s",
      activeTabIds: { s: "t", ghost: "t", personal: "missing" },
      downloads: [
        { id: "d", filename: "f", state: "downloading", startedAt: 5, received: -1, total: 10.7 },
        { id: "d", filename: "g", state: "finished", startedAt: 9 },
      ],
      archive: [
        { id: "a", url: "https://a.example/", title: "A", createdAt: 1, lastVisit: 1, closedAt: 3 },
        { id: "b", url: "https://a.example/", title: "A2", createdAt: 1, lastVisit: 1, closedAt: 9 },
      ],
      favicons: { "example.com": "file:///e.png", "BAD HOST": "file:///x.png", "ok.com": "https://not-file" },
      leftAt: 123,
      history: [
        { url: "https://h.example/", title: "H", lastVisit: 7, visits: 2.9 },
        { url: "https://h.example/", title: "H", lastVisit: 8, visits: 0 },
      ],
    },
    fallback,
  );
  parseBrowserData({ version: 2 }, fallback);
  // Fractional numbers a document could hold: both stores keep them whole.
  parseBrowserData(
    {
      version: 2,
      tabs: [{ id: "f", url: "https://f.example/", title: "F", createdAt: 1.9, lastVisit: 2.5 }],
      history: [{ url: "https://f.example/", title: "F", lastVisit: 7.75, visits: 3.9 }],
      archive: [{ id: "g", url: "https://g.example/", title: "G", createdAt: 1, lastVisit: 1, closedAt: 3.3 }],
      downloads: [{ id: "d", filename: "f", state: "finished", startedAt: 5.5, received: 9.9, total: 10.1 }],
      bookmarks: {
        bookmarks: { kind: "folder", id: "bookmarks", title: "", children: ["b"], addedAt: 0 },
        b: { kind: "url", id: "b", title: "B", url: "https://b.example/", addedAt: 4.4 },
      },
      leftAt: 12.7,
    },
    fallback,
  );
  // Names and emoji cut at their limit on an emoji: neither store keeps half of one.
  parseBrowserData(
    {
      version: 2,
      spaces: [
        { id: "personal", name: "Me" },
        { id: "s", name: `${"a".repeat(39)}🏝️`, icon: "👨‍👩‍👧‍👦👨‍👩‍👧‍👦" },
      ],
      folders: [{ id: "x", spaceId: "s", name: `${"b".repeat(39)}🎧` }],
    },
    fallback,
  );

  for (const broken of [null, [], "text", { version: 3 }, { tabs: [] }]) {
    try {
      // SAFETY: these documents are broken on purpose; the parser must refuse each without trusting its type.
      parseBrowserData(broken as never, fallback);
    } catch {
      // Recorded as refused.
    }
  }
});
