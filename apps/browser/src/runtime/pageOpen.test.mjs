import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId, engineProfileFor } from "../store/model.ts";
import { splitOf } from "../store/splits.ts";
import { applyPageOpen, parsePageOpen } from "./pageOpen.ts";

let sequence = 0;
const offer = () => `bay-tab:00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
function setup(options = {}) {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://source.example/", ...options });
  const tabId = activeTabId(store.getState(), windowId);
  const profile = engineProfileFor(store.getState().tabs[tabId].spaceId, store.getState().spaces);
  const event = (patch = {}) => ({
    offerId: offer(),
    sourceTabId: tabId,
    sourceWindowId: windowId,
    sourceProfile: profile,
    profile,
    incognito: !!options.incognito,
    url: "https://opened.example/post-result",
    disposition: "foreground",
    ...patch,
  });
  return { store, windowId, tabId, event };
}
const adopted = (store, id, event) => {
  const tab = store.getState().tabs[id];
  assert.ok(tab);
  assert.equal(tab.adoptId, event.offerId);
  assert.equal(tab.navigation, null, "adoption must retain Chrome's POST body and opener");
  assert.equal(tab.url, event.url);
  return tab;
};

test("native page open validates exact fields, bounded text, opaque offers and browser booleans", () => {
  const { event } = setup();
  const good = event();
  assert.deepEqual(parsePageOpen(good), good);
  assert.equal(parsePageOpen({ ...good, url: "chrome://version/" }).url, "bay://version/");
  for (const bad of [
    null,
    [],
    Object.create(good),
    { ...good, adoptId: good.offerId },
    { ...good, sourceTabId: "" },
    { ...good, sourceWindowId: "" },
    { ...good, offerId: "tab:42" },
    { ...good, offerId: "restore:tab" },
    { ...good, incognito: 1 },
    { ...good, disposition: "newTab" },
    { ...good, sourceProfile: null },
    { ...good, profile: "x".repeat(1025) },
    { ...good, url: "x".repeat(1_048_577) },
    { ...good, url: "" },
  ])
    assert.throws(() => parsePageOpen(bad), /invalid native page open/);
});

test("foreground and background pages keep native offers and opener relationships", () => {
  const { store, windowId, tabId, event } = setup();
  const background = event({ disposition: "background" });
  const id = applyPageOpen(store, background);
  assert.equal(adopted(store, id, background).openerId, tabId);
  assert.equal(activeTabId(store.getState(), windowId), tabId);
  const foreground = event();
  const front = applyPageOpen(store, foreground);
  adopted(store, front, foreground);
  assert.equal(activeTabId(store.getState(), windowId), front);
});

test("replayed offers return their existing target even after the source closes", () => {
  const { store, tabId, event } = setup();
  const input = event();
  const id = applyPageOpen(store, input);
  store.getState().closeTab(tabId);
  const before = store.getState();
  assert.equal(applyPageOpen(store, input), id);
  assert.equal(store.getState(), before);
  store.getState().updateTab(id, { adoptId: undefined, wakeAdoptId: input.offerId });
  assert.equal(applyPageOpen(store, input), id);
});

test("missing or closed sources and incompatible public profiles never mutate the store", () => {
  const { store, tabId, event } = setup();
  for (const input of [event({ sourceTabId: "missing" }), event({ sourceProfile: "other" }), event({ profile: "other" }), event({ incognito: true })]) {
    const before = store.getState();
    assert.equal(applyPageOpen(store, input), null);
    assert.equal(store.getState(), before);
  }
  store.getState().closeTab(tabId);
  const before = store.getState();
  assert.equal(applyPageOpen(store, event()), null);
  assert.equal(store.getState(), before);
});

test("queued offers follow their opener's current owner after a cross-window handoff", () => {
  const { store, tabId, windowId, event } = setup();
  const input = event();
  const target = store.getState().createWindow();
  store.getState().moveTabsToWindow([tabId], target);
  assert.notEqual(target, windowId);
  const id = applyPageOpen(store, input);
  assert.equal(adopted(store, id, input).windowId, target);
});

test("extension pages map their native profile to a public space and reject missing windows", () => {
  const { store, windowId, event } = setup();
  const spaceId = store.getState().createSpace({ name: "Other" });
  store.setState((s) => ({ spaces: { ...s.spaces, [spaceId]: { ...s.spaces[spaceId], profileId: "shared-native" } } }));
  const input = event({ sourceTabId: undefined, sourceProfile: "shared-native", profile: "shared-native" });
  const id = applyPageOpen(store, input);
  assert.equal(adopted(store, id, input).spaceId, spaceId);
  assert.equal(store.getState().tabs[id].windowId, windowId);
  for (const patch of [{ sourceWindowId: "missing" }, { sourceProfile: "missing", profile: "missing" }]) {
    const before = store.getState();
    assert.equal(applyPageOpen(store, event({ sourceTabId: undefined, ...patch })), null);
    assert.equal(store.getState(), before);
  }
});

test("Little Bay links and splits transfer their offered pages behind a main window", () => {
  const { store, windowId, tabId, event } = setup({ small: true });
  const main = store.getState().createWindow();
  for (const disposition of ["foreground", "background", "split"]) {
    const input = event({ disposition });
    const id = applyPageOpen(store, input);
    assert.equal(adopted(store, id, input).windowId, main);
    assert.equal(store.getState().tabs[id].openerId, tabId);
    assert.equal(activeTabId(store.getState(), windowId), tabId);
  }
});

test("Little Bay creates a main window when no target exists and retains the native page", () => {
  const { store, windowId, event } = setup({ small: true });
  const input = event();
  const id = applyPageOpen(store, input);
  const tab = adopted(store, id, input);
  assert.notEqual(tab.windowId, windowId);
  assert.equal(store.getState().windows[tab.windowId].kind, undefined);
});

test("split links retain offered POST pages when replacing the next existing pane", () => {
  const { store, windowId, tabId, event } = setup();
  const other = store.getState().openSplitPane(windowId, { anchorTabId: tabId, url: "https://old.example/", background: true });
  const input = event({ disposition: "split" });
  const before = Object.keys(store.getState().tabs).length;
  const id = applyPageOpen(store, input);
  assert.notEqual(id, other.tabId);
  adopted(store, id, input);
  assert.equal(Object.keys(store.getState().tabs).length, before);
  assert.equal(store.getState().tabs[other.tabId], undefined);
  assert.deepEqual(splitOf(store.getState(), tabId).tabIds, [tabId, id]);
  assert.equal(activeTabId(store.getState(), windowId), tabId);
});

test("split links make a new pane with the native offer and keep the source active", () => {
  const { store, windowId, tabId, event } = setup();
  const input = event({ disposition: "split" });
  const id = applyPageOpen(store, input);
  adopted(store, id, input);
  assert.deepEqual(splitOf(store.getState(), tabId).tabIds, [tabId, id]);
  assert.equal(activeTabId(store.getState(), windowId), tabId);
});

test("a full split replaces its following pane without adding a fourth pane", () => {
  const { store, windowId, tabId, event } = setup();
  const ids = [tabId];
  for (let i = 0; i < 2; i++) ids.push(store.getState().newTab(windowId, { url: `https://pane${i}.example/` }));
  store.getState().createSplit(ids);
  const input = event({ sourceTabId: ids[1], disposition: "split" });
  const id = applyPageOpen(store, input);
  assert.notEqual(id, ids[2]);
  adopted(store, id, input);
  assert.equal(store.getState().tabs[ids[2]], undefined);
  assert.equal(splitOf(store.getState(), ids[1]).tabIds.at(-1), id);
});

test("foreground links from pinned pages open offered pages in peeks", () => {
  const { store, windowId, tabId, event } = setup();
  store.getState().togglePin(tabId);
  const input = event();
  const id = applyPageOpen(store, input);
  assert.equal(adopted(store, id, input).peekOf, tabId);
  assert.equal(store.getState().peeks[windowId].tabId, id);
});

test("current-tab navigation never replaces a live page with an unrelated offered page", () => {
  const { store, tabId, event } = setup();
  const input = event({ disposition: "current" });
  const before = store.getState();
  assert.equal(applyPageOpen(store, input), null);
  assert.equal(store.getState(), before);
  assert.equal(store.getState().tabs[tabId].adoptId, undefined);
});

test("new public windows retain offered pages and request native focus", () => {
  const { store, windowId, event } = setup();
  const focused = [];
  const input = event({ disposition: "window" });
  const id = applyPageOpen(store, input, { focusWindow: (id) => focused.push(id) });
  const tab = adopted(store, id, input);
  assert.notEqual(tab.windowId, windowId);
  assert.deepEqual(focused, [tab.windowId]);
});

test("native private offers from a public source are retained for a claimed fresh private window", () => {
  const { store, event } = setup();
  const input = event({ disposition: "incognito", incognito: true });
  const id = applyPageOpen(store, input);
  const tab = adopted(store, id, input);
  assert.equal(store.getState().windows[tab.windowId].incognito, true);
  assert.equal(tab.spaceId, `incognito:${tab.windowId}`);
});

test("public offers requested in private windows reload fresh and do not cross profiles", () => {
  const { store, event } = setup();
  const input = event({ disposition: "incognito" });
  const id = applyPageOpen(store, input);
  const tab = store.getState().tabs[id];
  assert.equal(store.getState().windows[tab.windowId].incognito, true);
  assert.equal(tab.adoptId, undefined);
  assert.equal(tab.navigation.url, input.url);
});

test("private source new windows always have separate sessions and fresh navigation", () => {
  const { store, windowId, event } = setup({ incognito: true });
  for (const disposition of ["window", "incognito"]) {
    const input = event({ disposition });
    const id = applyPageOpen(store, input);
    const tab = store.getState().tabs[id];
    assert.notEqual(tab.windowId, windowId);
    assert.equal(store.getState().windows[tab.windowId].incognito, true);
    assert.equal(tab.adoptId, undefined);
    assert.equal(tab.navigation.url, input.url);
  }
});

test("private pages open within their own session and reject another private session", () => {
  const { store, windowId, event } = setup({ incognito: true });
  const input = event();
  const id = applyPageOpen(store, input);
  assert.equal(adopted(store, id, input).windowId, windowId);
  const before = store.getState();
  assert.equal(applyPageOpen(store, event({ profile: "incognito:other" })), null);
  assert.equal(store.getState(), before);
});
