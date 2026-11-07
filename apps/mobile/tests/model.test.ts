import assert from "node:assert/strict";
import test from "node:test";

import {
  createTab,
  initialBrowserData,
  parseBrowserData,
  persistedBrowserData,
  reduceBrowserData,
  siteHost,
  SPACE_COLORS,
  type DownloadEvent,
} from "../src/store/model.ts";
import type { JsonValue } from "../src/store/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const page = (id: string, url: string, lastVisit = 0) => ({ ...createTab(id, lastVisit, url), title: id });

test("closing a tab archives it, picks a neighbour and restores later", () => {
  let data = { ...initialBrowserData(page("a", "https://a.com/")), tabs: [page("a", "https://a.com/"), page("b", "https://b.com/")], activeTabId: "a" };
  data = reduceBrowserData(data, { type: "close-tab", id: "a", now: 5, fallback: createTab("blank", 5) });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["b"],
  );
  assert.equal(data.activeTabId, "b");
  assert.equal(data.archive[0]?.id, "a");

  data = reduceBrowserData(data, { type: "restore-tab", id: "a", restoredId: "a2", now: 6 });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["b", "a2"],
  );
  assert.equal(data.activeTabId, "a2");
  assert.equal(data.archive.length, 0);
});

test("closing the last tab leaves a blank one, and blank tabs aren't archived", () => {
  let data = initialBrowserData(page("a", "https://a.com/"));
  data = reduceBrowserData(data, { type: "close-tab", id: "a", now: 1, fallback: createTab("blank", 1) });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["blank"],
  );
  data = reduceBrowserData(data, { type: "close-tab", id: "blank", now: 2, fallback: createTab("blank2", 2) });
  assert.equal(data.archive.length, 1);
});

test("stale tabs are archived, except the current one and pinned sites", () => {
  const now = 10 * DAY;

  let data = {
    ...initialBrowserData(page("current", "https://current.com/", 0)),
    tabs: [
      page("current", "https://current.com/", 0),
      page("old", "https://old.com/", 0),
      page("pinned", "https://pinned.com/", 0),
      page("fresh", "https://fresh.com/", now),
    ],
    activeTabId: "current",
    pinnedSites: [{ id: "p", url: "https://pinned.com/", title: "Pinned", favicon: null }],
  };

  data = reduceBrowserData(data, { type: "archive-stale", now });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["current", "pinned", "fresh"],
  );
  assert.deepEqual(
    data.archive.map((tab) => tab.id),
    ["old"],
  );
  data = reduceBrowserData({ ...data, preferences: { ...data.preferences, archiveAfterDays: null } }, { type: "archive-stale", now: now * 2 });
  assert.equal(data.archive.length, 1);
});

test("the archive can start after 12 hours", () => {
  let data = initialBrowserData(page("current", "https://current.com/", 0));
  const tab = page("old", "https://old.com/", 0);

  data = { ...data, tabs: [...data.tabs, tab], preferences: { ...data.preferences, archiveAfterDays: 0.5 } };
  data = reduceBrowserData(data, { type: "archive-stale", now: 13 * 60 * 60 * 1000 });
  assert.deepEqual(
    data.tabs.map((entry) => entry.id),
    ["current"],
  );
  assert.deepEqual(
    data.archive.map((entry) => entry.id),
    ["old"],
  );

  const saved = { version: 1, ...data, preferences: { ...data.preferences, archiveAfterDays: 0.5 } };
  assert.equal(parseBrowserData(JSON.parse(JSON.stringify(saved)), data).preferences.archiveAfterDays, 0.5);
});

test("visits count up and move to the top of history", () => {
  let data = initialBrowserData(createTab("a", 0));
  data = reduceBrowserData(data, { type: "visit", url: "https://a.com/", title: "A", favicon: null, now: 1 });
  data = reduceBrowserData(data, { type: "visit", url: "https://b.com/", title: "B", favicon: null, now: 2 });
  data = reduceBrowserData(data, { type: "visit", url: "https://a.com/", title: "A", favicon: null, now: 3 });
  assert.deepEqual(
    data.history.map((entry) => [entry.url, entry.visits]),
    [
      ["https://a.com/", 2],
      ["https://b.com/", 1],
    ],
  );
  assert.equal(reduceBrowserData(data, { type: "visit", url: "javascript:1", title: "", favicon: null, now: 4 }), data);
});

test("saved state is validated and repaired", () => {
  const fallback = initialBrowserData(createTab("fallback", 0));

  const data = parseBrowserData(
    {
      version: 1,
      tabs: [page("a", "https://a.com/"), page("a", "https://dupe.com/"), { id: "bad", url: "javascript:1" }],
      activeTabId: "missing",
      history: [
        { url: "https://a.com/", title: "A", visits: 2, lastVisit: 1 },
        { url: "file:///x", title: "", visits: 1, lastVisit: 1 },
      ],
      preferences: { searchEngineId: "bing", archiveAfterDays: 3 },
    },
    fallback,
  );

  assert.deepEqual(
    data.tabs.map((tab) => tab.url),
    ["https://a.com/"],
  );
  assert.equal(data.activeTabId, "a");
  assert.equal(data.history.length, 1);
  assert.deepEqual(data.preferences, {
    searchEngineId: "bing",
    archiveAfterDays: 7,
    blockContent: true,
    blockingPausedHosts: [],
    lockPrivateTabs: false,
    reader: { theme: "paper", font: "serif", size: 19 },
    hiddenElements: {},
    siteSettings: {},
    wallpaper: "bay",
    wallpaperPhoto: null,
    theme: "system",
    textSize: 100,
    searchSuggestions: true,
    skipAmp: true,
    pullToRefresh: true,
    startPageAfterHours: null,
    youtube: { shorts: false, suggestions: false, distractions: false },
  });
  assert.equal(data.spaces[0]?.id, "personal");
  assert.equal(data.activeSpaceId, "personal");
  assert.equal(data.activeTabIds["personal"], "a");
  assert.equal(data.folders.length, 0);
  assert.throws(() => parseBrowserData({ version: 99 }, fallback));
  assert.throws(() => parseBrowserData({}, fallback));
});

test("a title that arrives after the visit updates its history entry", () => {
  let data = initialBrowserData(createTab("a", 0));
  data = reduceBrowserData(data, { type: "visit", url: "https://a.com/", title: "", favicon: null, now: 1 });
  data = reduceBrowserData(data, { type: "page-title", url: "https://a.com/", title: "A" });
  assert.equal(data.history[0]?.title, "A");
  assert.equal(data.history[0]?.visits, 1);
  assert.equal(reduceBrowserData(data, { type: "page-title", url: "https://a.com/", title: "A" }), data);
});

test("private tabs are never archived, saved or put away", () => {
  const now = 10 * DAY;
  let data = initialBrowserData(page("a", "https://a.com/", 0));
  data = reduceBrowserData(data, { type: "new-tab", tab: { ...createTab("p", 0, "https://p.com/", true), title: "P" }, background: true });
  data = reduceBrowserData(data, { type: "archive-stale", now });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["a", "p"],
  );

  data = reduceBrowserData(data, { type: "activate-tab", id: "p", now });
  assert.deepEqual(
    persistedBrowserData(data).tabs.map((tab) => tab.id),
    ["a"],
  );
  assert.equal(persistedBrowserData(data).activeTabId, "a");

  data = reduceBrowserData(data, { type: "close-tab", id: "p", now, fallback: createTab("blank", now) });
  assert.equal(data.archive.length, 0);
});

test("browsing preferences change in one step and repair bad values", () => {
  let data = initialBrowserData(createTab("a", 0));
  data = reduceBrowserData(data, {
    type: "preferences",
    update: { theme: "dark", textSize: 130, youtube: { shorts: true, suggestions: false, distractions: false } },
  });
  assert.equal(data.preferences.theme, "dark");
  assert.equal(data.preferences.textSize, 130);
  assert.equal(data.preferences.youtube.shorts, true);
  assert.equal(reduceBrowserData(data, { type: "preferences", update: { theme: "dark" } }), data);
  // Out of range values fall back to the defaults.
  data = reduceBrowserData(data, { type: "preferences", update: { textSize: 999, startPageAfterHours: 5 } });
  assert.equal(data.preferences.textSize, 100);
  assert.equal(data.preferences.startPageAfterHours, null);
  const saved = parseBrowserData({ version: 1, preferences: { theme: "neon", skipAmp: false, startPageAfterHours: 4, youtube: { shorts: "yes" } } }, data);
  assert.equal(saved.preferences.theme, "system");
  assert.equal(saved.preferences.skipAmp, false);
  assert.equal(saved.preferences.startPageAfterHours, 4);
  assert.deepEqual(saved.preferences.youtube, { shorts: false, suggestions: false, distractions: false });
});

test("the time Bay left survives a restart, and bad values are dropped", () => {
  let data = initialBrowserData(createTab("a", 0));
  assert.equal(data.leftAt, null);
  data = reduceBrowserData(data, { type: "left", now: 42 });
  assert.equal(parseBrowserData({ version: 1, ...persistedBrowserData(data) }, data).leftAt, 42);
  assert.equal(parseBrowserData({ version: 1, leftAt: "soon" }, data).leftAt, null);
});

test("blocking can be turned off and paused per site", () => {
  let data = initialBrowserData(createTab("a", 0));
  assert.equal(data.preferences.blockContent, true);
  data = reduceBrowserData(data, { type: "pause-blocking", host: "www.News.com", paused: true });
  assert.deepEqual(data.preferences.blockingPausedHosts, ["news.com"]);
  assert.equal(reduceBrowserData(data, { type: "pause-blocking", host: "news.com", paused: true }), data);
  data = reduceBrowserData(data, { type: "pause-blocking", host: "news.com", paused: false });
  assert.deepEqual(data.preferences.blockingPausedHosts, []);
  data = reduceBrowserData(data, { type: "block-content", enabled: false });
  assert.equal(data.preferences.blockContent, false);
  const saved = parseBrowserData({ version: 1, preferences: { blockingPausedHosts: ["ok.com", "bad host", 4], lockPrivateTabs: "yes" } }, data);
  assert.deepEqual(saved.preferences.blockingPausedHosts, ["ok.com"]);
  assert.equal(saved.preferences.lockPrivateTabs, false);
  assert.equal(saved.preferences.blockContent, true);
});

test("reader settings survive persistence and clamp the text size", () => {
  let data = initialBrowserData(createTab("a", 0));
  data = reduceBrowserData(data, { type: "reader-settings", settings: { theme: "dark", font: "mono", size: 80 } });
  assert.deepEqual(data.preferences.reader, { theme: "dark", font: "mono", size: 28 });
  assert.equal(reduceBrowserData(data, { type: "reader-settings", settings: { theme: "dark", font: "mono", size: 28 } }), data);
  const restored = parseBrowserData(JSON.parse(JSON.stringify({ version: 1, ...persistedBrowserData(data) })), data);
  assert.deepEqual(restored.preferences.reader, data.preferences.reader);
  assert.notEqual(restored.preferences.reader, data.preferences.reader);
});

test("malformed reader settings use defaults and finite sizes stay within bounds", () => {
  const fallback = initialBrowserData(createTab("a", 0));
  const restore = (reader: JsonValue) => parseBrowserData({ version: 1, preferences: { reader } }, fallback).preferences.reader;
  assert.deepEqual(restore({ theme: "unknown", font: [], size: NaN }), { theme: "paper", font: "serif", size: 19 });
  assert.equal(restore({ size: -10 }).size, 14);
  assert.equal(restore({ size: 20.6 }).size, 21);
  assert.equal(restore({ size: Infinity }).size, 19);
  assert.deepEqual(restore(null), fallback.preferences.reader);
});

test("hidden element rules are scoped to hosts, deduplicated and removable", () => {
  let data = initialBrowserData(createTab("a", 0));
  data = reduceBrowserData(data, { type: "hidden-elements", host: "www.News.com", selectors: [" .ad ", ".ad", "", "#promo"] });
  assert.deepEqual(data.preferences.hiddenElements, { "news.com": [".ad", "#promo"] });
  assert.equal(reduceBrowserData(data, { type: "hidden-elements", host: "news.com", selectors: [".ad", "#promo"] }), data);
  assert.equal(reduceBrowserData(data, { type: "hidden-elements", host: "https://other.com/", selectors: [".ad"] }), data);
  data = reduceBrowserData(data, { type: "hidden-elements", host: "other.com", selectors: ["aside"] });
  data = reduceBrowserData(data, { type: "hidden-elements", host: "news.com", selectors: [] });
  assert.deepEqual(data.preferences.hiddenElements, { "other.com": ["aside"] });
  const restored = parseBrowserData(JSON.parse(JSON.stringify({ version: 1, ...persistedBrowserData(data) })), data);
  assert.deepEqual(restored.preferences.hiddenElements, data.preferences.hiddenElements);
});

test("restoring hidden element rules rejects malformed hosts and selector values", () => {
  const fallback = initialBrowserData(createTab("a", 0));
  const hiddenElements = JSON.parse('{"www.News.com":[".ad",".ad",4," "],"bad host":["div"],"__proto__":["body"],"ok.com":null,"[::1]":["aside"]}');
  const data = parseBrowserData({ version: 1, preferences: { hiddenElements } }, fallback);
  assert.deepEqual(data.preferences.hiddenElements, { "news.com": [".ad"], "[::1]": ["aside"] });
  assert.equal(Object.getPrototypeOf(data.preferences.hiddenElements), Object.prototype);
  const copy = initialBrowserData(createTab("b", 0), data.preferences);
  copy.preferences.reader.size = 25;
  copy.preferences.hiddenElements["news.com"].push("nav");
  assert.equal(data.preferences.reader.size, 19);
  assert.deepEqual(data.preferences.hiddenElements["news.com"], [".ad"]);
});

test("a waiting download says why until bytes arrive", () => {
  const update = (extra: Partial<DownloadEvent>) => ({
    id: "d1",
    url: "https://a.com/f",
    filename: "f.mkv",
    state: "progress" as const,
    received: 0,
    total: 0,
    private: false,
    ...extra,
  });

  let data = initialBrowserData(page("a", "https://a.com/"));
  data = reduceBrowserData(data, { type: "download", update: update({ waiting: "Waiting for Wi-Fi" }), now: 1 });
  assert.equal(data.downloads[0]?.waiting, "Waiting for Wi-Fi");
  const same = reduceBrowserData(data, { type: "download", update: update({ waiting: "Waiting for Wi-Fi" }), now: 2 });
  assert.equal(same, data);
  data = reduceBrowserData(data, { type: "download", update: update({ received: 5, total: 10 }), now: 3 });
  assert.equal(data.downloads[0]?.waiting, undefined);
});

test("downloads track an engine's updates and survive a restart as finished or failed", () => {
  const update = (state: "started" | "progress" | "finished" | "cancelled", extra = {}) => ({
    id: "d1",
    url: "https://a.com/file.pdf",
    filename: "file.pdf",
    state,
    received: 0,
    total: 0,
    private: false,
    ...extra,
  });

  let data = initialBrowserData(page("a", "https://a.com/"));
  data = reduceBrowserData(data, { type: "download", update: update("started"), now: 1 });
  data = reduceBrowserData(data, { type: "download", update: update("progress", { received: 10, total: 100 }), now: 2 });
  assert.equal(data.downloads[0]?.state, "downloading");
  assert.equal(data.downloads[0]?.startedAt, 1);
  // An unchanged update keeps the same data, so nothing re-renders.
  assert.equal(reduceBrowserData(data, { type: "download", update: update("progress", { received: 10, total: 100 }), now: 3 }), data);
  assert.notEqual(reduceBrowserData(data, { type: "download", update: update("progress", { received: 20, total: 100 }), now: 3 }), data);

  // Restarting Bay while it's still running can't resume it.
  const restored = parseBrowserData({ version: 1, ...JSON.parse(JSON.stringify(persistedBrowserData(data))) }, data);
  assert.equal(restored.downloads[0]?.state, "failed");

  data = reduceBrowserData(data, { type: "download", update: update("finished", { received: 100, total: 100, path: "/x/file.pdf" }), now: 3 });
  assert.equal(data.downloads[0]?.state, "finished");
  assert.equal(data.downloads[0]?.path, "/x/file.pdf");
  // A late update can't revive a finished download.
  assert.equal(reduceBrowserData(data, { type: "download", update: update("progress", { received: 50 }), now: 4 }), data);

  data = reduceBrowserData(data, { type: "download", update: { ...update("started"), id: "d2", private: true }, now: 5 });
  assert.deepEqual(
    data.downloads.map((item) => item.id),
    ["d2", "d1"],
  );
  assert.deepEqual(
    persistedBrowserData(data).downloads.map((item) => item.id),
    ["d1"],
  );
  // Clearing the list keeps downloads still running.
  data = reduceBrowserData(data, { type: "clear-downloads" });
  assert.deepEqual(
    data.downloads.map((item) => item.id),
    ["d2"],
  );
});

test("pins can be removed and put back in place; history entries can be removed or cleared", () => {
  let data = initialBrowserData(page("a", "https://a.example/"));
  data = reduceBrowserData(data, { type: "new-tab", tab: page("b", "https://b.example/"), background: false });
  data = reduceBrowserData(data, { type: "pin-site", tabId: "a", pinId: "pa" });
  data = reduceBrowserData(data, { type: "pin-site", tabId: "b", pinId: "pb" });
  const removed = data.pinnedSites[0]!;
  data = reduceBrowserData(data, { type: "remove-pin", id: "pa" });
  assert.deepEqual(
    data.pinnedSites.map((site) => site.id),
    ["pb"],
  );
  data = reduceBrowserData(data, { type: "add-pin", site: removed, index: 0 });
  assert.deepEqual(
    data.pinnedSites.map((site) => site.id),
    ["pa", "pb"],
  );
  assert.equal(reduceBrowserData(data, { type: "add-pin", site: removed, index: 0 }), data);

  data = reduceBrowserData(data, { type: "visit", url: "https://a.example/", title: "A", favicon: null, now: 1 });
  data = reduceBrowserData(data, { type: "visit", url: "https://b.example/", title: "B", favicon: null, now: 2 });
  data = reduceBrowserData(data, { type: "remove-history", url: "https://a.example/" });
  assert.deepEqual(
    data.history.map((entry) => entry.url),
    ["https://b.example/"],
  );
  data = reduceBrowserData(data, { type: "clear-history" });
  assert.equal(data.history.length, 0);
});

test("the archive keeps one entry per address, and entries can be removed or cleared", () => {
  const tabs = [page("a", "https://a.com/"), page("b", "https://a.com/"), page("c", "https://c.com/"), page("d", "https://d.com/")];
  let data = { ...initialBrowserData(tabs[0]), tabs, activeTabId: "d" };
  data = reduceBrowserData(data, { type: "close-tab", id: "a", now: 1, fallback: createTab("blank", 1) });
  data = reduceBrowserData(data, { type: "close-tab", id: "c", now: 2, fallback: createTab("blank", 2) });
  data = reduceBrowserData(data, { type: "close-tab", id: "b", now: 3, fallback: createTab("blank", 3) });
  assert.deepEqual(
    data.archive.map((tab) => tab.id),
    ["b", "c"],
  );
  data = reduceBrowserData(data, { type: "remove-archived", id: "c" });
  assert.deepEqual(
    data.archive.map((tab) => tab.id),
    ["b"],
  );
  assert.equal(reduceBrowserData(data, { type: "clear-archive" }).archive.length, 0);

  // Saved data from before the dedupe loads with the newest copy of each page.
  const saved = {
    version: 1,
    ...data,
    archive: [
      { ...page("x", "https://x.com/"), closedAt: 1 },
      { ...page("y", "https://x.com/"), closedAt: 9 },
    ],
  };

  assert.deepEqual(
    parseBrowserData(JSON.parse(JSON.stringify(saved)), data).archive.map((tab) => tab.id),
    ["y"],
  );
});

test("importing links opens unknown pages in the background and can archive them instead", () => {
  let data = initialBrowserData(page("a", "https://a.com/"));

  data = reduceBrowserData(data, {
    type: "import-tabs",
    tabs: [page("b", "https://b.com/"), page("a2", "https://a.com/"), page("c", "https://c.com/")],
  });
  assert.deepEqual(
    data.tabs.map((tab) => tab.id),
    ["a", "b", "c"],
  );
  assert.equal(data.activeTabId, "a");

  data = reduceBrowserData(data, { type: "import-archive", tabs: [page("d", "https://d.com/"), page("e", "https://e.com/")], now: 5 });
  assert.deepEqual(
    data.archive.map((tab) => [tab.id, tab.closedAt]),
    [
      ["d", 5],
      ["e", 5],
    ],
  );
});

test("the wallpaper is one of Bay's built-ins", () => {
  let data = initialBrowserData(page("a", "https://a.com/"));
  assert.equal(data.preferences.wallpaper, "bay");
  data = reduceBrowserData(data, { type: "wallpaper", id: "forest" });
  assert.equal(data.preferences.wallpaper, "forest");
  const saved = { version: 1, ...data, preferences: { ...data.preferences, wallpaper: "neon" } };
  assert.equal(parseBrowserData(JSON.parse(JSON.stringify(saved)), data).preferences.wallpaper, "bay");

  // A photo needs a file in the app; picking a built-in keeps it for later.
  assert.equal(reduceBrowserData(data, { type: "wallpaper", id: "photo" }), data);
  assert.equal(reduceBrowserData(data, { type: "wallpaper", id: "photo", photo: "https://x.com/a.jpg" }), data);
  data = reduceBrowserData(data, { type: "wallpaper", id: "photo", photo: "file:///docs/wallpaper-1.jpg" });
  assert.deepEqual([data.preferences.wallpaper, data.preferences.wallpaperPhoto], ["photo", "file:///docs/wallpaper-1.jpg"]);
  data = reduceBrowserData(data, { type: "wallpaper", id: "dusk" });
  data = reduceBrowserData(data, { type: "wallpaper", id: "photo" });
  assert.deepEqual([data.preferences.wallpaper, data.preferences.wallpaperPhoto], ["photo", "file:///docs/wallpaper-1.jpg"]);
});

test("site icons are kept per host, and clearing history drops the ones nothing else shows", () => {
  assert.equal(siteHost("https://www.Example.com:8080/a?b"), "example.com");
  assert.equal(siteHost("about:blank"), "");

  let data = {
    ...initialBrowserData(page("a", "https://www.a.com/")),
    history: [{ url: "https://h.com/", title: "", favicon: null, visits: 1, lastVisit: 1 }],
  };

  data = reduceBrowserData(data, { type: "favicon", host: "a.com", uri: "file:///a" });
  data = reduceBrowserData(data, { type: "favicon", host: "h.com", uri: "file:///h" });
  assert.deepEqual(Object.keys(data.favicons), ["a.com", "h.com"]);
  data = reduceBrowserData(data, { type: "clear-history" });
  assert.deepEqual(data.favicons, { "a.com": "file:///a" });
  data = reduceBrowserData(data, { type: "favicon", host: "a.com", uri: null });
  assert.deepEqual(data.favicons, {});
  const saved = { version: 1, ...data, favicons: { "b.com": "file:///b", "c.com": "https://tracker.example/c.png" } };
  assert.deepEqual(parseBrowserData(JSON.parse(JSON.stringify(saved)), data).favicons, { "b.com": "file:///b" });
});

test("site settings are kept per host, and an all-default entry means none at all", () => {
  let data = initialBrowserData(page("a", "https://www.a.com/"));

  const siteOf = () => data.preferences.siteSettings["a.com"];
  assert.equal(siteOf(), undefined);

  data = reduceBrowserData(data, { type: "site-settings", host: "www.a.com", update: { textSize: null, reader: true, desktopMode: false } });
  assert.deepEqual(siteOf(), { textSize: null, reader: true, desktopMode: false });

  data = reduceBrowserData(data, { type: "site-settings", host: "a.com", update: { textSize: 123, reader: true, desktopMode: false } });
  // Zoom snaps to the steps and the range the global zoom uses.
  assert.deepEqual(siteOf(), { textSize: 120, reader: true, desktopMode: false });

  data = reduceBrowserData(data, { type: "site-settings", host: "a.com", update: { textSize: 120, reader: true, desktopMode: true } });
  assert.deepEqual(siteOf(), { textSize: 120, reader: true, desktopMode: true });

  // Everything back to the globals drops the entry, regardless of where it was written from.
  data = reduceBrowserData(data, { type: "site-settings", host: "a.com", update: { textSize: null, reader: false, desktopMode: false } });
  assert.equal(siteOf(), undefined);

  // Unknown hosts or values change nothing.
  assert.equal(reduceBrowserData(data, { type: "site-settings", host: "", update: { textSize: null, reader: true, desktopMode: false } }), data);

  const saved = {
    version: 1,
    ...data,
    preferences: { ...data.preferences, siteSettings: { "a.com": { textSize: 500, reader: "yes", desktopMode: 2 }, junk: 3 } },
  };
  assert.deepEqual(parseBrowserData(JSON.parse(JSON.stringify(saved)), data).preferences.siteSettings, {
    "a.com": { textSize: 200, reader: false, desktopMode: false },
  });
  data = reduceBrowserData(data, { type: "site-settings", host: "a.com", update: { textSize: 120, reader: true, desktopMode: true } });
  assert.deepEqual(parseBrowserData(JSON.parse(JSON.stringify({ version: 1, ...data })), data).preferences.siteSettings, {
    "a.com": { textSize: 120, reader: true, desktopMode: true },
  });
});

test("spaces keep their own active tab, switching and closing stay within them", () => {
  let data = initialBrowserData(createTab("a", 0, "https://a.com/"));
  data = reduceBrowserData(data, { type: "new-tab", tab: createTab("b", 1, "https://b.com/"), background: false });
  assert.equal(data.activeTabId, "b");

  // A new space brings a blank tab and takes the screen.
  data = reduceBrowserData(data, {
    type: "create-space",
    space: { id: "work", name: "Work", color: "green" },
    blankTab: createTab("c", 5, "", false, "work"),
  });
  assert.deepEqual(
    data.spaces.map((space) => space.name),
    ["Personal", "Work"],
  );
  assert.equal(data.activeSpaceId, "work");
  assert.equal(data.activeTabId, "c");
  assert.equal(data.activeTabIds["work"], "c");

  data = reduceBrowserData(data, { type: "new-tab", tab: createTab("d", 6, "https://d.com/", false, "work"), background: false });
  assert.equal(data.activeTabId, "d");
  // Switching back to Personal resurrects its last visited tab (b), not a fresh blank one.
  data = reduceBrowserData(data, { type: "select-space", id: "personal" });
  assert.equal(data.activeSpaceId, "personal");
  assert.equal(data.activeTabId, "b");

  // Closing that tab doesn't leak into Work's stack.
  data = reduceBrowserData(data, { type: "close-tab", id: "b", now: 10, fallback: createTab("fallback", 10, "", false, "personal") });
  assert.equal(data.activeTabId, "a");
  assert.deepEqual(
    data.tabs.filter((tab) => tab.spaceId === "work").map((tab) => tab.id),
    ["c", "d"],
  );
});

test("deleting a space files its tabs into the first space and keeps its current tab's page", () => {
  let data = initialBrowserData(createTab("a", 0, "https://a.com/"));
  data = reduceBrowserData(data, { type: "new-tab", tab: createTab("b", 1, "https://b.com/"), background: false });
  data = reduceBrowserData(data, {
    type: "create-space",
    space: { id: "work", name: "Work", color: "orange" },
    blankTab: createTab("c", 2, "https://c.com/", false, "work"),
  });
  data = reduceBrowserData(data, { type: "new-folder", folder: { id: "articles", spaceId: "work", name: "Articles" } });
  data = reduceBrowserData(data, { type: "move-tab", id: "c", spaceId: "work", folderId: "articles" });
  // Deleting Work moves c into Personal and clears its folder.
  data = reduceBrowserData(data, { type: "delete-space", id: "work" });
  assert.deepEqual(
    data.spaces.map((space) => space.name),
    ["Personal"],
  );
  assert.equal(data.activeSpaceId, "personal");
  const moved = data.tabs.find((tab) => tab.id === "c");
  assert.equal(moved?.spaceId, "personal");
  assert.equal(moved?.folderId, null);
  assert.equal(data.folders.length, 0);
  assert.equal(data.activeTabId, "c");
  // Deleting the last remaining space is a no-op.
  assert.equal(reduceBrowserData(data, { type: "delete-space", id: "personal" }), data);
});

test("folders hold tabs inside a space and round-trip through saved state", () => {
  let data = initialBrowserData(createTab("a", 0, "https://a.com/"));
  data = reduceBrowserData(data, { type: "new-folder", folder: { id: "f1", spaceId: "personal", name: "Reading" } });
  data = reduceBrowserData(data, { type: "move-tab", id: "a", spaceId: "personal", folderId: "f1" });
  assert.equal(data.tabs[0]?.folderId, "f1");

  // Deleting the folder files the tab back to the top level.
  data = reduceBrowserData(data, { type: "delete-folder", id: "f1" });
  assert.equal(data.tabs[0]?.folderId, null);

  // v1 state migrates with everything in Personal.
  const saved = parseBrowserData(JSON.parse(JSON.stringify({ version: 1, tabs: data.tabs, activeTabId: data.activeTabId })), data);
  assert.deepEqual(
    saved.spaces.map((space) => space.id),
    ["personal"],
  );
  assert.deepEqual(
    saved.tabs.map((tab) => tab.spaceId),
    ["personal"],
  );

  // v2 state keeps its spaces, folders and the tabs' assignments.
  const v2 = parseBrowserData(
    JSON.parse(
      JSON.stringify({
        version: 2,
        ...data,
        spaces: [
          { id: "personal", name: "Personal", color: "gray" },
          { id: "work", name: "Work", color: "orange" },
          { id: "bogus", name: "Bogus", color: "pink" },
        ],
        folders: [
          { id: "w1", spaceId: "work", name: "Docs" },
          { id: "bad", spaceId: "missing", name: "Bad" },
        ],
        activeSpaceId: "work",
        activeTabIds: { work: "missing", personal: "a" },
        tabs: [{ ...data.tabs[0], spaceId: "work", folderId: "w1" }],
        activeTabId: "a",
      }),
    ),
    data,
  );
  assert.deepEqual(
    v2.spaces.map((space) => [space.id, space.color]),
    [
      ["personal", "gray"],
      ["work", "orange"],
      ["bogus", "gray"],
    ],
  );
  assert.deepEqual(
    v2.folders.map((folder) => folder.id),
    ["w1"],
  );
  assert.equal(v2.activeTabIds["work"], "a");
  assert.equal(v2.tabs[0]?.folderId, "w1");
});

test("persisting drops private tabs but keeps the spaces they sat in", () => {
  let data = initialBrowserData(createTab("a", 0, "https://a.com/"));
  data = reduceBrowserData(data, { type: "new-tab", tab: createTab("p", 1, undefined, true), background: false });
  const persisted = persistedBrowserData(data);
  assert.deepEqual(
    persisted.tabs.map((tab) => tab.id),
    ["a"],
  );
  assert.equal(persisted.activeTabId, "a");
});

test("spaces colours cover the palette and don't drift", () => {
  assert.deepEqual(SPACE_COLORS, ["blue", "green", "orange", "red", "violet", "gray"]);
});
