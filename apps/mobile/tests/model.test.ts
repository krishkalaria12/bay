import assert from "node:assert/strict";
import test from "node:test";

import { createTab, initialBrowserData, parseBrowserData, reduceBrowserData } from "../src/store/model.ts";

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
  assert.deepEqual(data.preferences, { searchEngineId: "bing", archiveAfterDays: 7 });
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
