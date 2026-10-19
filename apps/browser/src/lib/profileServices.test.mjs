import assert from "node:assert/strict";
import { test } from "node:test";
import { bookmarkUuidFor } from "../store/bookmarks.ts";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { createBrowserAuthority } from "../runtime/authority.ts";
import { MAX_HISTORY } from "../store/history.ts";
import { createHistoryService } from "./history.ts";
import { createBookmarksService } from "./bookmarks.ts";
import { createFaviconService } from "./favicons.ts";
import { createProfileDataCleanup } from "./profileData.ts";
import * as native from "../test-native-stub.mjs";

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const storeFor = (engine) => {
  const store = createBrowserStore();
  store.setState({ profiles: { local: { id: "local", name: "Local", color: "blue", icon: null, createdAt: 0, dataId: engine } }, profileOrder: ["local"] });
  return store;
};

test("history instances use their own shared-profile mappings and stop native events", async () => {
  native.docs.clear(); native.historyDbs.clear();
  native.chromeVisit("engine-a", "https://a.example/", "A");
  native.chromeVisit("engine-b", "https://b.example/", "B");
  const original = useBrowser.getState(), a = storeFor("engine-a"), b = storeFor("engine-b");
  const first = createHistoryService(a), second = createHistoryService(b);
  try {
    first.start(); second.start();
    await Promise.all([first.reload(), second.reload()]);
    assert.equal(a.getState().history.local[0].title, "A");
    assert.equal(b.getState().history.local[0].title, "B");
    first.dispose();
    const saved = a.getState().history;
    native.chromeVisit("engine-a", "https://later.example/", "Later", Date.now() + 100);
    native.chromeVisit("engine-b", "https://current.example/", "Current", Date.now() + 100);
    await settle();
    assert.equal(a.getState().history, saved);
    assert.equal(b.getState().history.local[0].title, "Current");
    assert.equal(useBrowser.getState(), original);
  } finally { first.dispose(); second.dispose(); }
});

test("disposed history and bookmark reads cannot replace store state", async () => {
  native.docs.clear();
  for (const factory of [createHistoryService, createBookmarksService]) {
    const store = storeFor("late-engine"), service = factory(store), initial = store.getState();
    const loading = service.reload();
    await Promise.resolve();
    service.dispose();
    await loading;
    assert.equal(store.getState(), initial);
  }
});

test("bookmark instances read and write only their own store and engine", async () => {
  native.docs.clear(); native.bookmarkDbs.clear();
  for (const [engine, id] of [["marks-a", "a"], ["marks-b", "b"]]) native.chromeBookmarkEdit(engine, [{ op: "add", id: bookmarkUuidFor(id), k: "u", t: id, u: `https://${id}.example/`, a: 1, parent: "bar", index: 0 }]);
  const original = useBrowser.getState(), a = storeFor("marks-a"), b = storeFor("marks-b");
  const first = createBookmarksService(a), second = createBookmarksService(b);
  try {
    first.start(); second.start();
    await Promise.all([first.reload(), second.reload()]);
    assert.ok(a.getState().bookmarks.nodes[bookmarkUuidFor("a")]);
    assert.equal(a.getState().bookmarks.nodes[bookmarkUuidFor("b")], undefined);
    assert.ok(b.getState().bookmarks.nodes[bookmarkUuidFor("b")]);
    a.getState().addBookmark({ profileId: "local", title: "New", url: "https://new.example/" });
    await first.reload();
    assert.ok([...native.chromeBookmarks("marks-a").values()].some((n) => n.u === "https://new.example/"));
    assert.ok(![...native.chromeBookmarks("marks-b").values()].some((n) => n.u === "https://new.example/"));
    assert.equal(useBrowser.getState(), original);
  } finally { first.dispose(); second.dispose(); }
});

test("favicon caches and download queues belong to their browser instance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = storeFor("icons-a"), b = storeFor("icons-b");
  const makeTab = (store) => { const w = store.getState().createWindow({ profileId: "local", url: "https://page.example/" }); return store.getState().windows[w].tabIds[0]; };
  const ta = makeTab(a), tb = makeTab(b);
  const first = createFaviconService(a, { downloadFavicon: async () => ({ uri: "data:a" }) });
  const second = createFaviconService(b, { downloadFavicon: async () => ({ uri: "data:b" }) });
  try {
    first.noteFavicon(ta, "https://icon.example/a"); second.noteFavicon(tb, "https://icon.example/b");
    await settle(); t.mock.timers.tick(16);
    assert.deepEqual(Object.keys(first.useFavicons.getState().profiles), ["icons-a"]);
    assert.deepEqual(Object.keys(second.useFavicons.getState().profiles), ["icons-b"]);
    assert.equal(first.resolveFavicon("https://page.example/", null, "local").uri, "data:a");
    assert.equal(second.resolveFavicon("https://page.example/", null, "local").uri, "data:b");
  } finally { first.dispose(); second.dispose(); }
});

test("late favicon download after disposal cannot refill its cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createBrowserStore(), w = store.getState().createWindow({ url: "https://late.example/" }), tab = store.getState().windows[w].tabIds[0];
  let resolve;
  const service = createFaviconService(store, { downloadFavicon: () => new Promise((r) => { resolve = r; }) });
  service.noteFavicon(tab, "https://icon.example/"); service.dispose();
  resolve({ uri: "data:late" }); await settle(); t.mock.timers.tick(100);
  assert.deepEqual(service.useFavicons.getState().profiles, {});
});

test("profile cleanup disposal cancels delays without affecting another instance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  native.deletedProfileData.length = 0;
  const a = createBrowserStore(), b = createBrowserStore();
  a.setState({ orphanedProfileData: ["discarded"] }); b.setState({ orphanedProfileData: ["removed"] });
  const first = createProfileDataCleanup(a), second = createProfileDataCleanup(b);
  try {
    first.start(); second.start(); first.dispose();
    t.mock.timers.tick(1500); await settle();
    assert.deepEqual(native.deletedProfileData, ["removed"]);
    assert.deepEqual(a.getState().orphanedProfileData, ["discarded"]);
    assert.deepEqual(b.getState().orphanedProfileData, []);
  } finally { first.dispose(); second.dispose(); }
});


test("history starts under the authority with JSON-safe complete and bounded views", async () => {
  native.docs.clear(); native.historyDbs.clear();
  const store = storeFor("authority-history");
  store.setState({ historyFloor: { local: 123 } });
  native.chromeVisit("authority-history", "https://single.example/", "Single", 1000);
  const authority = createBrowserAuthority({ epoch: "history-epoch", store });
  const history = createHistoryService(store);
  try {
    history.start(); await history.reload();
    assert.equal(authority.getSnapshot().state.history.local[0].title, "Single");
    assert.deepEqual(authority.getSnapshot().state.historyFloor, {});
    assert.deepEqual(JSON.parse(JSON.stringify(authority.getSnapshot())), authority.getSnapshot());

    const db = native.chromeHistory("authority-history");
    db.clear();
    for (let i = 0; i < MAX_HISTORY; i++) db.set(`https://entry.example/${i}`, { title: String(i), visits: [1000 + i] });
    await history.reload();
    assert.equal(authority.getSnapshot().state.historyFloor.local, 1000);
    assert.equal(authority.getSnapshot().state.history.local.length, MAX_HISTORY);

    db.clear();
    await history.reload();
    assert.deepEqual(authority.getSnapshot().state.historyFloor, {});
    assert.deepEqual(authority.getSnapshot().state.history.local, []);
  } finally { history.dispose(); authority.close(); }
});

test("a stopped profile cleanup cannot acknowledge deletion after restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  native.deletedProfileData.length = 0;
  const store = createBrowserStore();
  store.setState({ orphanedProfileData: ["pending"] });
  const service = createProfileDataCleanup(store);
  const stopFirst = service.start();
  t.mock.timers.tick(1500);
  await Promise.resolve();
  assert.deepEqual(native.deletedProfileData, ["pending"]);
  stopFirst();
  const stopSecond = service.start();
  stopFirst();
  await settle();
  assert.deepEqual(store.getState().orphanedProfileData, ["pending"]);
  t.mock.timers.tick(1500); await settle();
  assert.deepEqual(store.getState().orphanedProfileData, []);
  stopSecond();
});

test("a closed private tab's late favicon cannot repopulate its profile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createBrowserStore();
  const window = store.getState().createWindow({ incognito: true, url: "https://secret.example/" });
  const tab = store.getState().windows[window].tabIds[0];
  let resolve;
  const service = createFaviconService(store, { downloadFavicon: () => new Promise((r) => { resolve = r; }) });
  try {
    service.start(); service.noteFavicon(tab, "https://icon.example/");
    store.getState().closeWindow(window);
    resolve({ uri: "data:secret" }); await settle(); t.mock.timers.tick(100);
    assert.deepEqual(service.useFavicons.getState().profiles, {});
  } finally { service.dispose(); }
});


test("disposal before start does not strand a restarted service behind old work", async () => {
  native.docs.clear(); native.historyDbs.clear(); native.bookmarkDbs.clear();
  native.chromeVisit("restarted", "https://restart.example/", "Restart");
  native.chromeBookmarkEdit("restarted", [{ op: "add", id: bookmarkUuidFor("restart"), k: "u", t: "Restart", u: "https://restart.example/", a: 1, parent: "bar", index: 0 }]);
  for (const factory of [createHistoryService, createBookmarksService]) {
    const store = storeFor("restarted"), service = factory(store);
    const old = service.reload();
    service.dispose();
    try {
      service.start();
      await old; await service.reload();
      if (factory === createHistoryService) assert.equal(store.getState().history.local[0].title, "Restart");
      else assert.equal(store.getState().bookmarks.nodes[bookmarkUuidFor("restart")].title, "Restart");
    } finally { service.dispose(); }
  }
});


test("a private favicon cached before disposal cannot survive a stopped-window close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createBrowserStore();
  const window = store.getState().createWindow({ incognito: true, url: "https://private-cache.example/" });
  const { profileId, tabIds: [tab] } = store.getState().windows[window];
  const service = createFaviconService(store, { downloadFavicon: async () => ({ uri: "data:private-cache" }) });
  try {
    service.start(); service.noteFavicon(tab, "https://icon.example/private");
    await settle(); t.mock.timers.tick(16);
    assert.equal(service.resolveFavicon("https://private-cache.example/", null, profileId).uri, "data:private-cache");
    service.dispose();
    store.getState().closeWindow(window);
    service.start();
    assert.deepEqual(store.getState().windows, {});
    assert.equal(service.useFavicons.getState().profiles[profileId], undefined);
    assert.equal(service.resolveFavicon("https://private-cache.example/", null, profileId), null);
  } finally { service.dispose(); }
});
