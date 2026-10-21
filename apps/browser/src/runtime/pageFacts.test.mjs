import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId, engineProfileFor } from "../store/model.ts";
import { createPageFactConsumer } from "./pageFacts.ts";

const navigation = (url = "https://page.example/", title = "Page") => ({
  url,
  title,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  themeColor: "#123456",
  themeColorSource: "meta",
  audible: false,
  muted: false,
});
function setup(options = { url: "https://requested.example/" }) {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow(options);
  const tabId = activeTabId(store.getState(), windowId);
  const consumer = createPageFactConsumer(store);
  let sequence = 0;
  const fact = (event, payload, extra = {}) => ({
    tabId,
    profile: engineProfileFor(store.getState().tabs[tabId]?.spaceId ?? "default", store.getState().spaces),
    browserId: 7,
    sequence: ++sequence,
    event,
    payload,
    ...extra,
  });
  const apply = (event, payload, extra) => consumer.apply(fact(event, payload, extra));
  return { store, windowId, tabId, consumer, fact, apply };
}

test("page facts update the authority across windows and for public tabs without an owner", () => {
  const { store, tabId, apply } = setup();
  const other = store.getState().createWindow({ url: "https://other.example/" });
  const otherTab = activeTabId(store.getState(), other);
  const before = store.getState().tabs[otherTab];
  assert.equal(apply("onNavigationChange", { ...navigation(), audible: true, muted: true }), true);
  assert.equal(store.getState().tabs[tabId].url, "https://page.example/");
  assert.equal(store.getState().live[tabId].playingAudio, true);
  assert.equal(store.getState().tabs[tabId].muted, false, "mute intent remains a user command");
  store.getState().updateTab(tabId, { windowId: "" });
  assert.equal(apply("onNavigationChange", navigation("https://page.example/", "Ownerless")), true);
  assert.equal(store.getState().tabs[tabId].title, "Ownerless");
  assert.equal(store.getState().tabs[otherTab], before);
});

test("profile checks include private and shared sign-in profiles without consulting window ownership", () => {
  const { store, tabId, apply } = setup({ incognito: true, url: "https://private.example/" });
  const before = store.getState();
  assert.equal(apply("onNavigationChange", navigation(), { profile: "" }), false);
  assert.equal(store.getState(), before);
  assert.equal(apply("onNavigationChange", navigation()), true);
  assert.equal(store.getState().tabs[tabId].title, "Page");
  const shared = store.getState().createSpace({ name: "Shared" });
  store.setState((s) => ({ spaces: { ...s.spaces, [shared]: { ...s.spaces[shared], profileId: "native-profile" } } }));
  store.getState().updateTab(tabId, { spaceId: shared });
  assert.equal(apply("onProgress", { progress: 0.4 }, { profile: shared }), false);
  assert.equal(apply("onProgress", { progress: 0.4 }, { profile: "native-profile" }), true);
});

test("malformed facts do not mutate state or consume a later sequence", () => {
  const { store, consumer, fact } = setup();
  const good = fact("onProgress", { progress: 0.5 }, { sequence: 100 });
  const sparse = [];
  sparse.length = 1;
  const bad = [
    null,
    [],
    Object.create(good),
    { ...good, windowId: "forged" },
    ...[0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"].map((sequence) => ({ ...good, sequence })),
    { ...good, browserId: 0 },
    { ...good, tabId: "" },
    { ...good, tabId: "x".repeat(1025) },
    { ...good, event: "onPageMessage", payload: {} },
    ...[-0.1, 1.1, NaN, Infinity, "0.5"].map((progress) => ({ ...good, payload: { progress } })),
    { ...good, payload: { progress: 0.5, url: "forged" } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), audible: 1 } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), themeColor: "red" } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), themeColorSource: "forged" } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), browserId: 8 } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), title: "x".repeat(65_537) } },
    { ...good, event: "onNavigationChange", payload: { ...navigation(), url: "x".repeat(1_048_577) } },
    { ...good, event: "onFavicon", payload: { url: "icon", urls: [null] } },
    { ...good, event: "onFavicon", payload: { url: "icon", urls: sparse } },
    { ...good, event: "onFavicon", payload: { url: "", urls: [] } },
    { ...good, event: "onMedia", payload: { playing: true, muted: "false" } },
    { ...good, event: "onZoom", payload: { zoom: 0 } },
    { ...good, event: "onZoom", payload: { zoom: 1, pinchScale: Infinity } },
    { ...good, event: "onFindResult", payload: { count: 1, active: 0.5 } },
    { ...good, event: "onDownloadNavigation", payload: { committedUrl: "", skipped: "false" } },
    { ...good, event: "onDiscarded", payload: { url: null } },
    { ...good, event: "onLoadError", payload: { url: "", code: NaN, text: "error" } },
  ];
  const before = store.getState();
  for (const input of bad) {
    assert.equal(consumer.apply(input), false);
    assert.equal(store.getState(), before);
  }
  assert.equal(consumer.apply({ ...good, sequence: 1 }), true);
  assert.equal(store.getState().live[good.tabId].progress, 0.5);
});

test("per-tab sequences reject delayed reports and retired pages even with a newer sequence", () => {
  const { store, tabId, consumer, fact } = setup();
  assert.equal(consumer.apply(fact("onNavigationChange", navigation(), { sequence: 20 })), true);
  const before = store.getState();
  assert.equal(consumer.apply(fact("onProgress", { progress: 0.1 }, { sequence: 20 })), false);
  assert.equal(consumer.apply(fact("onProgress", { progress: 0.1 }, { sequence: 19 })), false);
  assert.equal(store.getState(), before);
  assert.equal(consumer.apply(fact("onNavigationChange", navigation("https://new.example/"), { browserId: 8, sequence: 21 })), true);
  assert.equal(consumer.apply(fact("onNavigationChange", navigation("https://old.example/"), { browserId: 7, sequence: 22 })), false);
  assert.equal(store.getState().tabs[tabId].url, "https://new.example/");
});

test("missing, closed, sleeping and internal tabs reject late facts", () => {
  const { store, tabId, apply } = setup();
  assert.equal(apply("onProgress", { progress: 0.3 }, { tabId: "missing" }), false);
  store.getState().updateTab(tabId, { unloaded: true });
  let before = store.getState();
  assert.equal(apply("onProgress", { progress: 0.3 }), false);
  assert.equal(store.getState(), before);
  store.getState().updateTab(tabId, { unloaded: false, navigation: { url: "bay://history", seq: 99 } });
  before = store.getState();
  assert.equal(apply("onNavigationChange", navigation()), false);
  assert.equal(store.getState(), before);
  store.getState().updateTab(tabId, { navigation: null, url: "bay://downloads" });
  assert.equal(apply("onProgress", { progress: 0.3 }), false);
  store.getState().closeTab(tabId);
  assert.equal(apply("onProgress", { progress: 0.3 }), false);
});

test("pending navigation suppresses initial blank once per navigation rather than every title report", () => {
  const { store, tabId, apply } = setup();
  const requested = store.getState().tabs[tabId].url;
  assert.equal(apply("onNavigationChange", navigation("about:blank", "")), true);
  assert.equal(store.getState().tabs[tabId].url, requested);
  assert.equal(store.getState().live[tabId].isLoading, true);
  apply("onNavigationChange", navigation());
  apply("onNavigationChange", navigation("https://page.example/", "Updated title"));
  apply("onNavigationChange", navigation("about:blank", "Blank"));
  assert.equal(store.getState().tabs[tabId].url, "about:blank");
  store.getState().navigate(tabId, "https://next.example/");
  apply("onNavigationChange", navigation("about:blank", ""));
  assert.equal(store.getState().tabs[tabId].url, "about:blank");
  assert.equal(store.getState().live[tabId].isLoading, true);
  apply("onLoadError", { url: "https://next.example/", code: -105, text: "name not resolved" });
  apply("onNavigationChange", navigation("about:blank", "Error"));
  assert.equal(store.getState().tabs[tabId].title, "Error");
});

test("adopted pages suppress blank and navigation normalizes engine URLs", () => {
  const { store, tabId, apply } = setup();
  store.getState().updateTab(tabId, { navigation: null, adoptId: "tab:42" });
  apply("onNavigationChange", navigation("", ""));
  assert.equal(store.getState().tabs[tabId].url, "https://requested.example/");
  apply("onNavigationChange", navigation("chrome://version/", "Version"));
  assert.equal(store.getState().tabs[tabId].url, "bay://version/");
});

test("progress, favicon, audio, zoom, find and discard facts preserve unrelated user state", () => {
  const { store, tabId, apply } = setup();
  store.getState().updateTab(tabId, { customTitle: "Mine", muted: true });
  apply("onProgress", { progress: 0.75 });
  apply("onFavicon", { url: "https://page.example/icon.png", urls: ["https://page.example/other.png"] });
  apply("onMedia", { playing: true, muted: false });
  apply("onZoom", { zoom: 1.25, host: "page.example", isDefault: false, pinchScale: 1 });
  apply("onFindResult", { count: 5, active: 2, final: true });
  assert.equal(store.getState().tabs[tabId].favicon, "https://page.example/icon.png");
  assert.equal(store.getState().tabs[tabId].zoom, 1.25);
  assert.equal(store.getState().tabs[tabId].customTitle, "Mine");
  assert.equal(store.getState().tabs[tabId].muted, true);
  assert.equal(store.getState().live[tabId].progress, 0.75);
  assert.equal(store.getState().live[tabId].playingAudio, true);
  assert.equal(store.getState().find[tabId].count, 5);
  assert.equal(store.getState().find[tabId].active, 2);
  assert.equal(store.getState().find[tabId].open, false);
  apply("onDiscarded", { url: "https://requested.example/" });
  assert.equal(store.getState().live[tabId].progress, 0);
  assert.equal(store.getState().live[tabId].playingAudio, false);
  apply("onNavigationChange", navigation("about:blank", ""));
  assert.equal(store.getState().tabs[tabId].url, "https://requested.example/");
});

test("download navigation keeps a committed page, closes empty opened tabs, and clears other empty pages", () => {
  const { store, windowId, tabId, apply } = setup();
  apply("onDownloadNavigation", { committedUrl: "https://committed.example/", skipped: false });
  assert.equal(store.getState().tabs[tabId].url, "https://committed.example/");
  assert.equal(store.getState().live[tabId].isLoading, false);
  const opened = store.getState().newTab(windowId, { url: "https://file.example/", openerId: tabId });
  apply("onDownloadNavigation", { committedUrl: "", skipped: false }, { tabId: opened });
  assert.equal(store.getState().tabs[opened], undefined);
  const skipped = store.getState().newTab(windowId, { url: "https://file.example/", openerId: tabId });
  apply("onDownloadNavigation", { committedUrl: "", skipped: true }, { tabId: skipped });
  assert.equal(store.getState().tabs[skipped].url, "");
  store.getState().updateLive(tabId, { canGoBack: true });
  store.getState().updateTab(tabId, { adoptId: "tab:9", title: "Download", favicon: "icon" });
  apply("onDownloadNavigation", { committedUrl: "", skipped: false });
  assert.equal(store.getState().tabs[tabId].url, "");
  assert.equal(store.getState().tabs[tabId].title, "");
  assert.equal(store.getState().tabs[tabId].favicon, null);
});

test("disposed consumers reject facts without changing state", () => {
  const { store, consumer, apply } = setup();
  consumer.dispose();
  consumer.dispose();
  const before = store.getState();
  assert.equal(apply("onProgress", { progress: 0.7 }), false);
  assert.equal(store.getState(), before);
});

test("structural tab removal releases browser and sequence tracking, including closed peeks", () => {
  const { store, windowId, tabId, apply } = setup();
  const peek = store.getState().openPeek(tabId, "https://peek.example/");
  apply("onProgress", { progress: 0.2 }, { tabId: peek, browserId: 10, sequence: 100 });
  apply("onProgress", { progress: 0.3 }, { tabId: peek, browserId: 11, sequence: 101 });
  const savedPeek = store.getState().tabs[peek];
  const savedLive = store.getState().live[peek];
  store.getState().closePeek(windowId);
  assert.equal(store.getState().tabs[peek], undefined);
  store.setState((s) => ({ tabs: { ...s.tabs, [peek]: savedPeek }, live: { ...s.live, [peek]: savedLive } }));
  assert.equal(apply("onProgress", { progress: 0.4 }, { tabId: peek, browserId: 10, sequence: 1 }), true);
  assert.equal(store.getState().live[peek].progress, 0.4, "removed pages retain neither sequence nor retired browser IDs");
});

test("profile changes release old page identity and disposal removes the structural subscription", () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://page.example/" });
  const tabId = activeTabId(store.getState(), windowId);
  const subscribe = store.subscribe;
  let unsubscribed = 0;
  store.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    let stopped = false;
    return () => {
      if (!stopped) unsubscribed++;
      stopped = true;
      unsubscribe();
    };
  };
  const consumer = createPageFactConsumer(store);
  const fact = { tabId, profile: "", browserId: 1, sequence: 100, event: "onProgress", payload: { progress: 0.2 } };
  assert.equal(consumer.apply(fact), true);
  store.setState((s) => ({ spaces: { ...s.spaces, default: { ...s.spaces.default, profileId: "other-native-profile" } } }));
  assert.equal(consumer.apply({ ...fact, profile: "other-native-profile", sequence: 1 }), true);
  consumer.dispose();
  consumer.dispose();
  assert.equal(unsubscribed, 1);
});

test("closing a pinned page releases tracking even though its tab remains in the same list", () => {
  const { store, windowId, tabId, apply } = setup();
  store.getState().newTab(windowId, { url: "https://other.example/" });
  store.getState().togglePin(tabId);
  apply("onProgress", { progress: 0.2 }, { sequence: 100 });
  const lists = store.getState().tabLists;
  store.getState().closeTab(tabId);
  assert.equal(store.getState().tabLists, lists);
  assert.equal(store.getState().tabs[tabId].unloaded, true);
  store.getState().activate(tabId, windowId);
  assert.equal(apply("onProgress", { progress: 0.3 }, { sequence: 1 }), true);
});
