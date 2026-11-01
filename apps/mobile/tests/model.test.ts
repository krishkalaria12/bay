import assert from "node:assert/strict";
import test from "node:test";

import { createTab, initialBrowserData, parseBrowserData, persistedBrowserData, reduceBrowserData } from "../src/store/model.ts";

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
  });
  assert.throws(() => parseBrowserData({ version: 2 }, fallback));
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
  const restore = (reader: unknown) => parseBrowserData({ version: 1, preferences: { reader } }, fallback).preferences.reader;
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
