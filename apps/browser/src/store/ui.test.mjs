import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { activeTabId } = await import("./model.ts");
const { setAppUrlOpener } = await import("./tabs.ts");
const { openNewTabPanel } = await import("../lib/newTab.ts");
const { focusedWindows } = await import("../test-native-stub.mjs");

const S = () => useBrowser.getState();
const tabLists = await import("./model.ts");
// A window's list: its space's tabs, in sidebar order (store/model.ts).
const tabsOf = (w) => tabLists.listIds(S(), tabLists.windowListKey(S(), S().windows[w]));
const reset = () => S().hydrate({});

test("opening, reopening and cancelling New Tab keeps the current tab and creates no tabs", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const current = activeTabId(S(), w);
  const tabs = S().tabs;
  S().openNewTabPanel(w);
  const first = S().windowUi[w].panel;
  assert.equal(first.mode, "newTab");
  assert.equal(first.initialText, "");
  S().openNewTabPanel(w);
  assert.notEqual(S().windowUi[w].panel.sessionId, first.sessionId);
  S().closePanel(w);
  assert.equal(activeTabId(S(), w), current);
  assert.equal(S().tabs, tabs);
  assert.deepEqual(S().windowUi[w].panel, { open: false, initialText: "" });
});

test("navigation sessions reset New Tab context and each request has a fresh identity", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const group = S().groupTabs(tabsOf(w));
  S().openNewTabPanel(w, group);
  const first = S().windowUi[w].panel.sessionId;
  S().openPanel(w, "a.com");
  const panel = S().windowUi[w].panel;
  assert.equal(panel.mode, "navigate");
  assert.equal(panel.initialText, "a.com");
  assert.equal(panel.groupId, undefined);
  assert.notEqual(panel.sessionId, first);
  assert.equal(S().submitNewTabPanel(w, "b.com"), "");
});

test("New Tab submission creates a URL tab exactly once and preserves the underlying page", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const current = activeTabId(S(), w);
  const before = S().tabs[current];
  S().openNewTabPanel(w);
  assert.equal(S().submitNewTabPanel(w, "  "), "");
  assert.equal(S().windowUi[w].panel.open, true);
  const opened = S().submitNewTabPanel(w, "b.com");
  assert.equal(S().tabs[opened].url, "https://b.com");
  assert.equal(activeTabId(S(), w), opened);
  assert.equal(S().tabs[current], before);
  assert.equal(tabsOf(w).length, 2);
  assert.equal(S().submitNewTabPanel(w, "c.com"), "");
  assert.equal(tabsOf(w).length, 2);
});

test("explicit New Tab preserves an adopted blank instead of overwriting it", () => {
  reset();
  const w = S().createWindow();
  const blank = activeTabId(S(), w);
  S().updateTab(blank, { adoptId: "kept-browser" });
  S().openNewTabPanel(w);
  const opened = S().submitNewTabPanel(w, "b.com");
  assert.notEqual(opened, blank);
  assert.equal(S().tabs[blank].url, "");
  assert.equal(S().tabs[blank].adoptId, "kept-browser");
});

test("group New Tab waits for submission then inserts a loaded tab into the requested group", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const current = activeTabId(S(), w);
  const group = S().groupTabs([current]);
  S().updateGroup(group, { collapsed: true });
  S().openNewTabPanel(w, group);
  assert.deepEqual(S().groups[group].tabIds, [current]);
  const opened = S().submitNewTabPanel(w, "b.com");
  assert.equal(S().tabs[opened].url, "https://b.com");
  assert.deepEqual(S().groups[group].tabIds, [current, opened]);
  assert.equal(S().groups[group].collapsed, false);
});

test("group submissions preserve app URL routing without creating a blank placeholder", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const group = S().groupTabs(tabsOf(w));
  const tabs = S().tabs;
  let routed = null;
  setAppUrlOpener((url, windowId) => {
    routed = { url, windowId };
    return true;
  });
  try {
    S().openNewTabPanel(w, group);
    assert.equal(S().submitNewTabPanel(w, "bay://settings"), "");
    assert.deepEqual(routed, { url: "bay://settings", windowId: w });
    assert.equal(S().tabs, tabs);
  } finally {
    setAppUrlOpener(() => false);
  }
});

test("navigating to an app URL keeps a fresh New Tab palette opened by its handler", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const current = activeTabId(S(), w);
  const tabs = S().tabs;
  S().openPanel(w, "a.com");
  const originalSession = S().windowUi[w].panel.sessionId;
  setAppUrlOpener((_url, windowId) => {
    S().openNewTabPanel(windowId);
    return true;
  });
  try {
    S().navigate(current, "bay://newtab");
    assert.equal(S().windowUi[w].panel.open, true);
    assert.equal(S().windowUi[w].panel.mode, "newTab");
    assert.notEqual(S().windowUi[w].panel.sessionId, originalSession);
    assert.equal(S().tabs, tabs);
  } finally {
    setAppUrlOpener(() => false);
  }
});

test("stale, foreign-window and foreign-profile group requests cannot create a tab", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  // A window that can't show the group: a private one (a main window on its space lists it too).
  const other = S().createWindow({ incognito: true });
  const group = S().groupTabs(tabsOf(w));
  S().openNewTabPanel(other, group);
  assert.equal(S().windowUi[other]?.panel.open, undefined);
  S().openNewTabPanel(w, group);
  S().ungroup(group);
  assert.equal(S().submitNewTabPanel(w, "b.com"), "");
  assert.equal(tabsOf(w).length, 1);
  const foreign = S().createSpace({ name: "Work" });
  const foreignTab = S().newTab(w, { url: "work.com", spaceId: foreign });
  const foreignGroup = S().groupTabs([foreignTab]);
  // Back on the first space: its list is the window's again.
  S().activate(tabLists.spaceTabIds(S(), "default")[0], w);
  S().openNewTabPanel(w, foreignGroup);
  assert.equal(S().windowUi[w].panel.open, false);
});

test("private New Tab submissions remain in their private profile", () => {
  reset();
  const w = S().createWindow({ incognito: true, url: "secret.com" });
  S().openNewTabPanel(w);
  const opened = S().submitNewTabPanel(w, "private.com");
  assert.equal(S().tabs[opened].spaceId, S().windows[w].spaceId);
  assert.match(S().tabs[opened].spaceId, /^incognito:/);
});

test("Little Bay sends New Tab to an existing main window and focuses it", () => {
  reset();
  focusedWindows.length = 0;
  const main = S().createWindow({ url: "a.com" });
  const small = S().createWindow({ small: true, url: "small.com" });
  const count = Object.keys(S().tabs).length;
  openNewTabPanel(small);
  assert.equal(S().windowUi[main].panel.mode, "newTab");
  assert.equal(S().windowUi[small]?.panel.open, undefined);
  assert.equal(Object.keys(S().tabs).length, count);
  assert.equal(S().ui.focusedWindowId, main);
  assert.deepEqual(focusedWindows, [main]);
});

test("Little Bay creates a main window with one reusable initial blank when needed", () => {
  reset();
  focusedWindows.length = 0;
  const small = S().createWindow({ small: true, url: "small.com" });
  openNewTabPanel(small);
  const main = S().windowOrder.find((id) => id !== small);
  assert.ok(main);
  assert.equal(S().windows[main].kind, undefined);
  assert.equal(S().windowUi[main].panel.mode, "navigate");
  const initial = activeTabId(S(), main);
  S().navigate(initial, "a.com");
  assert.equal(tabsOf(main).length, 1);
  assert.equal(S().tabs[initial].url, "https://a.com");
  assert.deepEqual(focusedWindows, [main]);
});

test("the palette and the downloads panel close each other", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  S().setDownloadsOpen(w, true);
  S().openPanel(w);
  assert.equal(S().windowUi[w].downloadsOpen, false);
  S().setDownloadsOpen(w, true);
  assert.equal(S().windowUi[w].panel.open, false);
  S().openNewTabPanel(w);
  assert.equal(S().windowUi[w].downloadsOpen, false);
  S().setDownloadsOpen(w, false);
  assert.equal(S().windowUi[w].panel.open, true);
});
