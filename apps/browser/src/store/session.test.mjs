// What survives a quit, a relaunch and a closed window: session.json, history (Chrome's) and pinned tabs.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { migrateHistoryFile, reloadHistory, startHistory } = await import("../lib/history.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../lib/persist.ts");
const stub = await import("../test-native-stub.mjs");

const S = () => useBrowser.getState();
const tabLists = await import("./model.ts");
// A window's list: its space's tabs, in sidebar order (store/model.ts).
const tabsOf = (w) => tabLists.listIds(S(), tabLists.windowListKey(S(), S().windows[w]));
const reset = () => S().hydrate({});
const view = (w) => model.viewTabIds(S(), w).map((id) => S().tabs[id].url);
const active = (w) => model.activeTabId(S(), w);

let clock = Date.now();
function at(fn) {
  const now = Date.now;
  Date.now = () => (clock += 1000);
  try {
    return fn();
  } finally {
    Date.now = now;
  }
}
const select = (id) => at(() => S().activate(id));

function windowWith(...hosts) {
  const w = at(() => S().createWindow({ url: `${hosts[0]}.com` }));
  const ids = [model.viewTabIds(S(), w)[0]];
  for (const h of hosts.slice(1)) ids.push(at(() => S().newTab(w, { url: `${h}.com` })));
  return { w, ids };
}

test("hydrate repairs dangling references", () => {
  S().hydrate({
    spaces: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    windows: {
      w1: { id: "w1", spaceId: "gone", incognito: false, tabIds: ["t1", "missing"], activeTabIds: { gone: "missing" }, sidebarOpen: true, frame: null, createdAt: 0 },
      w2: { id: "w2", spaceId: "default", incognito: false, tabIds: [], activeTabIds: {}, sidebarOpen: true, frame: null, createdAt: 0 },
    },
    tabs: {
      t1: { id: "t1", windowId: "w1", spaceId: "default", url: "https://a.com", title: "", favicon: null, pinned: false, muted: false, zoom: 1, customTitle: null, customIcon: null, navigation: null, openerId: null, createdAt: 0, lastActiveAt: 0 },
      t2: { id: "t2", windowId: "nowhere", spaceId: "default", url: "https://b.com", title: "", favicon: null, pinned: false, muted: false, zoom: 1, customTitle: null, customIcon: null, navigation: null, openerId: null, createdAt: 0, lastActiveAt: 0 },
    },
    groups: { g: { id: "g", windowId: "w1", spaceId: "default", name: "", icon: null, color: null, collapsed: false, pinned: false, tabIds: ["missing"], createdAt: 0 } },
  });
  assert.deepEqual(S().windowOrder, ["w1", "w2"], "a window with no tabs of its own still shows its space");
  assert.equal(S().windows.w1.spaceId, "default");
  assert.equal(active("w1"), "t1");
  assert.ok(S().tabs.t2, "a tab whose window is gone stays its space's");
  assert.equal(active("w2"), "t2", "the other window shows it: not the tab w1 shows");
  assert.deepEqual(S().groups, {});
});

// 0.2.12: Reopen Closed Window lost each tab's Back and Forward. A closed window's tabs stay their space's, unloaded,
// each keeping its back/forward list until it's shown again.
test("a closed window's tabs wait with their back/forward list, and come back with the window", () => {
  reset();
  S().createWindow({ url: "keep.com" });
  const w = S().createWindow({ url: "a.com" });
  const a = active(w);
  const b = S().newTab(w, { url: "b.com", background: true });
  const lazy = S().newTab(w, { url: "c.com", background: true, snapshot: { url: "https://c.com" } });
  S().updateTab(lazy, { navigation: null });
  S().closeWindow(w);
  assert.equal(S().tabs[a].windowId, "", "its page closed with the window");
  assert.match(S().tabs[b].wakeAdoptId, new RegExp(`^restore:${b}$`), "it waits with its history");
  assert.equal(S().tabs[b].navigation, null);
  assert.equal(S().tabs[lazy].wakeAdoptId, undefined, "a tab that never loaded has none");
  S().reopenClosedWindow();
  const w2 = S().windowOrder.at(-1);
  assert.equal(active(w2), a, "the window shows what it showed");
  assert.match(S().tabs[a].adoptId, new RegExp(`^restore:${a}$`), "the shown tab loads with its history");
  S().activate(b, w2);
  assert.match(S().tabs[b].adoptId, new RegExp(`^restore:${b}$`));
  assert.equal(S().tabs[b].wakeAdoptId, undefined);
});

test("profiles sharing data still share it after a save and reload", () => {
  reset();
  const a = S().createSpace({ name: "A" });
  const b = S().createSpace({ name: "B", shareWith: a });
  S().importHistory(b, [{ url: "https://a.com/", title: "A", visits: 1, lastVisit: Date.now() }]);
  const saved = JSON.parse(JSON.stringify({ spaces: S().spaces, spaceOrder: S().spaceOrder, history: S().history, bookmarks: S().bookmarks }));
  reset();
  assert.equal(model.engineProfile(b), b, "registry follows the loaded profiles");
  S().hydrate(saved);
  assert.equal(model.engineProfile(b), a);
  assert.equal(S().history[a], S().history[b]);
  assert.deepEqual(S().bookmarks.roots[a], S().bookmarks.roots[b]);
});

const flushEvents = () => new Promise((r) => setTimeout(r, 0));
const DAY = 86_400_000;

// 0.2.20: history moved from history.json into Chrome's HistoryService, which had recorded the same visits all
// along, a moment apart.
test("history.json moves into Chrome once: Chrome's own visits aren't doubled, a second run adds nothing", async () => {
  reset();
  stub.docs.clear();
  stub.historyDbs.clear();
  const now = Date.now();
  const work = S().createSpace({ name: "Work" });
  const shared = S().createSpace({ name: "Shared", shareWith: work });
  // Chrome recorded a.com 20 s after the app did; b.com (imported) and c.com (another Mac's) only the app has.
  stub.chromeVisit("", "https://a.com/", "A", now - DAY + 20_000);
  // d.com: Chrome has one of two visits 30 s apart; the other is still added.
  stub.chromeVisit("", "https://d.com/", "D", now - DAY);
  const entry = (url, times, title = url) => ({ url, title, favicon: null, visits: times.length, lastVisit: times.at(-1), visitTimes: times });
  const list = [
    entry("https://a.com/", [now - DAY]),
    entry("https://b.com/", [now - 3 * DAY, now - 2 * DAY]),
    entry("https://d.com/", [now - DAY, now - DAY + 30_000]),
    entry("https://old.com/", [now - 200 * DAY]),
  ];
  const workList = [entry("https://c.com/", [now - DAY])];
  stub.docs.set("history.json", JSON.stringify({ version: 2, history: { default: list, [work]: workList, [shared]: workList, gone: [entry("https://x.com/", [now])] } }));

  assert.equal(await migrateHistoryFile(now, { keepMs: 0 }), "moved");
  const visits = (profile, url) => stub.chromeHistory(profile).get(url)?.visits.length ?? 0;
  assert.equal(visits("", "https://a.com/"), 1, "a visit Chrome has isn't added again");
  assert.equal(visits("", "https://b.com/"), 2);
  assert.equal(visits("", "https://d.com/"), 2, "one visit Chrome has accounts for one saved visit");
  assert.equal(visits("", "https://old.com/"), 0, "Chrome has expired what's older than 90 days");
  assert.equal(visits(work, "https://c.com/"), 1, "profiles sharing data add their list once");
  assert.equal(stub.historyDbs.get(null).has("gone"), false, "a deleted profile's list goes");
  assert.equal(stub.docs.has("history.json"), false, "the file is deleted");

  // A launch that stopped before deleting the file runs it again: nothing more is added.
  stub.docs.set("history.json", JSON.stringify({ version: 2, history: { default: list, [work]: workList } }));
  assert.equal(await migrateHistoryFile(now, { keepMs: 0 }), "moved");
  assert.deepEqual([visits("", "https://a.com/"), visits("", "https://b.com/"), visits("", "https://d.com/"), visits(work, "https://c.com/")], [1, 2, 2, 1]);
  assert.equal(await migrateHistoryFile(now, { keepMs: 0 }), "none");
});

// With history.json still to move, Chrome's history isn't watched (nor read) until the move is done: each moved
// visit came to the JS as an event (~88,000 for a long-used profile, ~200 ms of startup JS), all ignored.
test("history.json's move goes before watching Chrome's history; the view then has the moved visits", async () => {
  reset();
  stub.docs.clear();
  stub.historyDbs.clear();
  stub.historyWatches.length = 0;
  const now = Date.now();
  const entry = (url, times) => ({ url, title: url, favicon: null, visits: times.length, lastVisit: times.at(-1), visitTimes: times });
  stub.docs.set("history.json", JSON.stringify({ version: 2, history: { default: [entry("https://moved.com/", [now - DAY, now - 1000])] } }));
  const stop = startHistory();
  assert.deepEqual(stub.historyWatches, [], "not watched while the file moves");
  for (let i = 0; i < 50 && !S().history.default?.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(stub.historyWatches, [""], "watched once it's in");
  assert.equal(S().history.default?.[0]?.url, "https://moved.com/");
  assert.equal(S().history.default[0].visits, 2);
  stop();
});

test("history is a view of Chrome's: visits, deletions and a relaunch all read back what Chrome has", async () => {
  reset();
  stub.docs.clear();
  stub.historyDbs.clear();
  const stop = startHistory();
  await reloadHistory();
  const urls = () => (S().history.default ?? []).map((h) => h.url);
  stub.chromeVisit("", "https://a.com/", "A");
  stub.chromeVisit("", "https://b.com/", "B");
  await flushEvents();
  assert.deepEqual(urls(), ["https://b.com/", "https://a.com/"]);
  assert.ok(S().historyReady.default);

  S().removeHistory("default", ["https://a.com/"]);
  assert.deepEqual(urls(), ["https://b.com/"], "gone from the view at once");
  await flushEvents();
  assert.equal(stub.chromeHistory("").has("https://a.com/"), false, "and from Chrome");
  await reloadHistory();
  assert.deepEqual(urls(), ["https://b.com/"], "a relaunch doesn't bring it back");

  const before = S().history.default;
  await reloadHistory();
  assert.deepEqual(S().history.default, before);
  stop();
});

// Pinned tabs (0.2.2): ⌘W unloads a pinned tab instead of closing it, and a closed window parks its pins for the
// profile's next window.

test("⌘W on a pinned tab unloads its page; the tile stays with its title, icon and pinned URL", () => {
  reset();
  const { w, ids: [p, a] } = windowWith("mail", "a");
  S().togglePin(p);
  S().updateTab(p, { title: "Inbox", favicon: "data:mail" });
  select(p);
  S().closeTab(p);
  const tile = S().tabs[p];
  assert.ok(tile, "the pinned tab still exists");
  assert.equal(tile.pinned, true);
  assert.equal(tile.url, "https://mail.com");
  assert.equal(tile.title, "Inbox");
  assert.equal(tile.favicon, "data:mail");
  assert.equal(tile.navigation, null, "no page: its web view unmounts");
  assert.equal(tile.adoptId, undefined);
  assert.equal(tile.unloaded, true);
  assert.deepEqual(view(w), ["https://mail.com", "https://a.com"]);
  assert.equal(active(w), a);
});

// 0.2.8: with a pinned tab open, holding ⌘W alternated forever between a New Tab page and the pinned site.
test("holding ⌘W over pinned tiles ends by closing the window: no unloaded page wakes", () => {
  reset();
  const { w, ids: [x] } = windowWith("x", "a");
  S().togglePin(x);
  select(x);
  const wakes = [];
  for (let i = 0; i < 10 && S().windows[w]; i++) {
    const before = S().tabs[x].navigation;
    S().closeTab(active(w));
    if (S().windows[w] && !before && S().tabs[x].navigation) wakes.push(i);
  }
  assert.deepEqual(wakes, [], "x.com never loads again");
  assert.equal(S().windows[w], undefined, "the window closed, as in Dia");
  assert.ok(S().tabs[x].pinned && S().tabs[x].unloaded, "the tile stays the space's, unloaded, for its next window");
});

const sidebar = (w) =>
  model.viewTabIds(S(), w).filter((id) => model.inPinnedContainer(S(), id)).map((id) => {
    const t = S().tabs[id];
    const g = Object.values(S().groups).find((g) => g.tabIds.includes(id));
    return `${g ? `${g.name}/` : ""}${t.url}${t.navigation || t.adoptId ? " (loaded)" : ""}`;
  });

function pinnedWindow() {
  const { w, ids: [mail, docs, jira, wiki, a] } = windowWith("mail", "docs", "jira", "wiki", "a");
  S().togglePin(mail);
  S().togglePin(docs);
  const work = S().groupTabs([jira, wiki], { pinned: true });
  S().updateGroup(work, { name: "Work" });
  select(a);
  select(mail);
  return { w, mail, work };
}
const PINS = ["https://mail.com", "https://docs.com", "Work/https://jira.com", "Work/https://wiki.com"];

// 0.2.8: closing a window took its pinned tabs with it, so the next window had none. They're the space's, as Arc's.
test("⌘W until the window closes, then ⌘N: the pinned tabs and pinned groups are there, in order, unloaded", () => {
  reset();
  const { w, mail, work } = pinnedWindow();
  assert.deepEqual(sidebar(w), ["https://mail.com (loaded)", "https://docs.com (loaded)", "Work/https://jira.com (loaded)", "Work/https://wiki.com (loaded)"]);
  for (let i = 0; i < 12 && S().windows[w]; i++) S().closeTab(active(w));
  assert.equal(S().windows[w], undefined, "the window closed");
  const n = S().createWindow();
  assert.deepEqual(sidebar(n), PINS, "same tiles, same order, the group still pinned, nothing loaded");
  assert.equal(S().tabs[active(n)].url, "", "the new window shows a New Tab page");
  assert.ok(S().tabs[mail], "the same tab (its key in sync)");
  assert.equal(S().groups[work].pinned, true);
  // A second window lists the same ones: they're the space's.
  const n2 = S().createWindow();
  assert.deepEqual(sidebar(n2), PINS);
});

test("⇧⌘T after the close, then ⌘N: one set of pinned tabs", () => {
  reset();
  const { w } = pinnedWindow();
  S().closeWindow(w);
  S().reopenClosed(null);
  const restored = S().ui.focusedWindowId;
  assert.notEqual(restored, w);
  assert.deepEqual(sidebar(restored), ["https://mail.com (loaded)", ...PINS.slice(1)], "the reopened window shows what it showed");
  assert.deepEqual(model.viewTabIds(S(), restored).filter((id) => !model.inPinnedContainer(S(), id)).map((id) => S().tabs[id].url), ["https://a.com"]);
  const n = S().createWindow();
  assert.deepEqual(sidebar(n), ["https://mail.com (loaded)", ...PINS.slice(1)], "⌘N lists the same tabs (mail's page is in the other window)");
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://mail.com").length, 1, "one tab");
});

test("quit and relaunch after the window closed: the next window has the pinned tabs, unloaded", () => {
  stub.docs.clear();
  reset();
  const stop = startPersistence();
  const { w } = pinnedWindow();
  S().closeWindow(w);
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  assert.equal(S().windowOrder.length, 0, "no window restored");
  const n = S().createWindow();
  assert.deepEqual(sidebar(n), PINS);
});
