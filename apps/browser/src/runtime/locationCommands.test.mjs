import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId } from "../store/model.ts";
import { executeLocationCommand, parseLocationCommand } from "./locationCommands.ts";

const windowWithTab = (store, options) => {
  const windowId = store.getState().createWindow(options);
  return { windowId, tabId: activeTabId(store.getState(), windowId) };
};
const run = (store, command, effects) => executeLocationCommand(store, parseLocationCommand(command), effects);

test("location intent parser accepts only its closed fields and bounded typed values", () => {
  const good = [
    { method: "openLocation", sourceTabId: "tab", url: "example.com", disposition: "current" },
    { method: "switchToExistingTab", sourceTabId: "tab", targetTabId: "other" },
    { method: "requestNewTab", windowId: "window", groupId: "group" },
    { method: "submitNewTab", windowId: "window", url: "example.com" },
    { method: "dismissCommandPanel", windowId: "window" },
    { method: "openCommandPanel", windowId: "window", initialText: "" },
  ];
  for (const command of good) {
    const parsed = parseLocationCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseLocationCommand({ ...command, profileId: "forged" }), { code: "invalid_request" });
  }
  for (const command of [
    null, [], Object.create(good[0]), { method: "navigate" },
    { ...good[0], disposition: "background" }, { ...good[0], url: " " },
    { ...good[0], url: "x".repeat(1_048_577) }, { ...good[0], sourceTabId: "x".repeat(1025) },
    { ...good[1], targetTabId: 42 }, { ...good[2], groupId: null },
    { ...good[3], windowId: "" }, { ...good[4], options: {} },
    { ...good[5], initialText: false }, { ...good[5], initialText: "x".repeat(1_048_577) },
  ]) assert.throws(() => parseLocationCommand(command), { code: "invalid_request" });
  assert.equal(parseLocationCommand({ ...good[0], url: "x".repeat(1_048_576) }).url.length, 1_048_576);
  assert.deepEqual(parseLocationCommand({ method: "requestNewTab", windowId: "window", groupId: undefined }), { method: "requestNewTab", windowId: "window" });
});

test("location opening derives the source profile and opener, preserving background panel state", () => {
  const store = createBrowserStore();
  const { windowId, tabId } = windowWithTab(store, { url: "source.com" });
  const profileId = store.getState().createProfile({ name: "Work" });
  const source = store.getState().newTab(windowId, { url: "work.com", profileId });
  store.getState().activate(tabId);
  store.getState().openPanel(windowId, "query");
  run(store, { method: "openLocation", sourceTabId: source, url: "next.com", disposition: "newTab" });
  const opened = activeTabId(store.getState(), windowId);
  assert.equal(store.getState().tabs[opened].profileId, profileId);
  assert.equal(store.getState().tabs[opened].openerId, source);
  assert.equal(store.getState().windowUi[windowId].panel.open, false);
  store.getState().openPanel(windowId, "keep");
  const panel = store.getState().windowUi[windowId].panel;
  run(store, { method: "openLocation", sourceTabId: source, url: "background.com", disposition: "backgroundTab" });
  const background = Object.values(store.getState().tabs).find((tab) => tab.url === "https://background.com");
  assert.equal(background.profileId, profileId);
  assert.equal(background.openerId, null);
  assert.equal(activeTabId(store.getState(), windowId), opened);
  assert.equal(store.getState().windowUi[windowId].panel, panel);
});

test("blank source tabs never become an opener and current navigation preserves app URL routing", () => {
  let store;
  store = createBrowserStore({ openAppUrl: (url, windowId) => {
    if (url !== "yahu://newtab") return false;
    store.getState().openNewTabPanel(windowId);
    return true;
  } });
  const { windowId, tabId } = windowWithTab(store);
  run(store, { method: "openLocation", sourceTabId: tabId, url: "next.com", disposition: "newTab" });
  assert.equal(store.getState().tabs[activeTabId(store.getState(), windowId)].openerId, null);
  store.getState().openPanel(windowId, "route");
  const originalSession = store.getState().windowUi[windowId].panel.sessionId;
  const tabs = store.getState().tabs;
  run(store, { method: "openLocation", sourceTabId: tabId, url: "yahu://newtab", disposition: "current" });
  assert.equal(store.getState().tabs, tabs);
  assert.equal(store.getState().windowUi[windowId].panel.mode, "newTab");
  assert.notEqual(store.getState().windowUi[windowId].panel.sessionId, originalSession);
});

test("private dispositions stay private and new windows receive a fresh private profile", () => {
  const store = createBrowserStore();
  const { windowId, tabId } = windowWithTab(store, { incognito: true, url: "secret.com" });
  const profileId = store.getState().windows[windowId].profileId;
  for (const disposition of ["newTab", "backgroundTab"]) run(store, { method: "openLocation", sourceTabId: tabId, url: "private.com", disposition });
  for (const tab of Object.values(store.getState().tabs)) assert.equal(tab.profileId, profileId);
  run(store, { method: "openLocation", sourceTabId: tabId, url: "newprivate.com", disposition: "newWindow" });
  const next = store.getState().windows[store.getState().windowOrder.at(-1)];
  assert.equal(next.incognito, true);
  assert.notEqual(next.profileId, profileId);
  assert.equal(next.profileId, `incognito:${next.id}`);
});

test("switching existing tabs closes the source panel and focuses a public destination explicitly", () => {
  const store = createBrowserStore();
  const source = windowWithTab(store, { url: "source.com" });
  const target = windowWithTab(store, { url: "target.com" });
  store.getState().setFocusedWindow(source.windowId);
  store.getState().openPanel(source.windowId);
  const focused = [];
  run(store, { method: "switchToExistingTab", sourceTabId: source.tabId, targetTabId: target.tabId }, { focusWindow: (id) => focused.push(id) });
  assert.equal(store.getState().windowUi[source.windowId].panel.open, false);
  assert.equal(store.getState().ui.focusedWindowId, target.windowId);
  assert.deepEqual(focused, [target.windowId]);
  run(store, { method: "switchToExistingTab", sourceTabId: target.tabId, targetTabId: target.tabId }, { focusWindow: (id) => focused.push(id) });
  assert.deepEqual(focused, [target.windowId]);
});

test("private switching cannot cross privacy boundaries or private window owners", () => {
  const store = createBrowserStore();
  const publicTab = windowWithTab(store, { url: "public.com" });
  const a = windowWithTab(store, { incognito: true, url: "a.com" });
  const b = windowWithTab(store, { incognito: true, url: "b.com" });
  for (const [source, target] of [[publicTab, a], [a, publicTab], [a, b]]) {
    const before = store.getState();
    assert.throws(() => run(store, { method: "switchToExistingTab", sourceTabId: source.tabId, targetTabId: target.tabId }), { code: "invalid_request" });
    assert.equal(store.getState(), before);
  }
  const targetTabId = store.getState().newTab(a.windowId, { url: "same-owner.com", background: true });
  run(store, { method: "switchToExistingTab", sourceTabId: a.tabId, targetTabId });
  assert.equal(activeTabId(store.getState(), a.windowId), targetTabId);
});

test("requesting and submitting New Tab preserves groups and private ownership", () => {
  for (const incognito of [false, true]) {
    const store = createBrowserStore();
    const { windowId, tabId } = windowWithTab(store, { incognito, url: "source.com" });
    const groupId = store.getState().groupTabs([tabId]);
    const tabs = store.getState().tabs;
    run(store, { method: "requestNewTab", windowId, groupId });
    assert.equal(store.getState().tabs, tabs);
    assert.equal(store.getState().windowUi[windowId].panel.mode, "newTab");
    run(store, { method: "submitNewTab", windowId, url: "next.com" });
    const opened = activeTabId(store.getState(), windowId);
    assert.deepEqual(store.getState().groups[groupId].tabIds, [tabId, opened]);
    assert.equal(store.getState().tabs[opened].profileId, store.getState().windows[windowId].profileId);
    const count = Object.keys(store.getState().tabs).length;
    run(store, { method: "submitNewTab", windowId, url: "duplicate.com" });
    assert.equal(Object.keys(store.getState().tabs).length, count);
  }
});

test("Harbor New Tab reuses the matching main window or opens a reusable initial blank", () => {
  for (const existingMain of [false, true]) {
    const store = createBrowserStore();
    const main = existingMain ? windowWithTab(store, { url: "main.com" }).windowId : undefined;
    const harbor = windowWithTab(store, { small: true, url: "harbor.com" });
    const focused = [];
    run(store, { method: "requestNewTab", windowId: harbor.windowId }, { focusWindow: (id) => focused.push(id) });
    const target = main ?? store.getState().windowOrder.find((id) => id !== harbor.windowId);
    assert.equal(store.getState().windowUi[target].panel.mode, existingMain ? "newTab" : "navigate");
    assert.equal(store.getState().windows[harbor.windowId].tabIds.length, 1);
    assert.deepEqual(focused, [target]);
    if (!existingMain) {
      const initial = activeTabId(store.getState(), target);
      run(store, { method: "openLocation", sourceTabId: initial, url: "first.com", disposition: "current" });
      assert.deepEqual(store.getState().windows[target].tabIds, [initial]);
    }
  }
});

test("panel commands keep blank-page navigation mode and dismiss without changing tabs", () => {
  const store = createBrowserStore();
  const { windowId } = windowWithTab(store);
  const tabs = store.getState().tabs;
  run(store, { method: "openCommandPanel", windowId, initialText: "restored" });
  assert.equal(store.getState().windowUi[windowId].panel.mode, "navigate");
  assert.equal(store.getState().windowUi[windowId].panel.initialText, "restored");
  run(store, { method: "dismissCommandPanel", windowId });
  assert.equal(store.getState().windowUi[windowId].panel.open, false);
  assert.equal(store.getState().tabs, tabs);
});

test("missing sources, malformed ownership and foreign groups reject before mutation", () => {
  const store = createBrowserStore();
  const a = windowWithTab(store, { url: "a.com" });
  const b = windowWithTab(store, { url: "b.com" });
  const groupId = store.getState().groupTabs([b.tabId]);
  const foreignProfile = store.getState().createProfile({ name: "Other" });
  const foreignTab = store.getState().newTab(a.windowId, { profileId: foreignProfile, url: "other.com" });
  const foreignGroup = store.getState().groupTabs([foreignTab]);
  store.getState().activate(a.tabId);
  for (const command of [
    { method: "openLocation", sourceTabId: "missing", url: "x.com", disposition: "newWindow" },
    { method: "requestNewTab", windowId: a.windowId, groupId },
    { method: "requestNewTab", windowId: a.windowId, groupId: "missing" },
    { method: "requestNewTab", windowId: a.windowId, groupId: foreignGroup },
    { method: "openCommandPanel", windowId: "missing" },
    { method: "submitNewTab", windowId: "missing", url: "x.com" },
    { method: "dismissCommandPanel", windowId: "missing" },
  ]) {
    const before = store.getState();
    assert.throws(() => run(store, command), { code: "invalid_request" });
    assert.equal(store.getState(), before);
  }
  store.setState({ tabs: { ...store.getState().tabs, [a.tabId]: { ...store.getState().tabs[a.tabId], windowId: b.windowId } } });
  const before = store.getState();
  assert.throws(() => run(store, { method: "openLocation", sourceTabId: a.tabId, url: "x.com", disposition: "newTab" }), { code: "invalid_request" });
  assert.equal(store.getState(), before);
});

test("a private window cannot use another private owner's profile", () => {
  const store = createBrowserStore();
  const a = windowWithTab(store, { incognito: true, url: "a.com" });
  const b = windowWithTab(store, { incognito: true, url: "b.com" });
  const foreignProfile = store.getState().windows[b.windowId].profileId;
  store.setState({
    windows: { ...store.getState().windows, [a.windowId]: { ...store.getState().windows[a.windowId], profileId: foreignProfile } },
    tabs: { ...store.getState().tabs, [a.tabId]: { ...store.getState().tabs[a.tabId], profileId: foreignProfile } },
  });
  const before = store.getState();
  for (const command of [
    { method: "openLocation", sourceTabId: a.tabId, url: "x.com", disposition: "newTab" },
    { method: "requestNewTab", windowId: a.windowId },
  ]) assert.throws(() => run(store, command), { code: "invalid_request" });
  assert.equal(store.getState(), before);
});

test("automatic blank-page panel requests do not reopen after navigation or tab switching", () => {
  const store = createBrowserStore();
  const { windowId, tabId } = windowWithTab(store);
  run(store, { method: "openCommandPanel", windowId, sourceTabId: tabId });
  assert.equal(store.getState().windowUi[windowId].panel.open, true);
  run(store, { method: "dismissCommandPanel", windowId });
  store.getState().navigate(tabId, "navigated.com");
  const afterNavigation = store.getState();
  run(store, { method: "openCommandPanel", windowId, sourceTabId: tabId });
  assert.equal(store.getState(), afterNavigation);
  const blank = store.getState().newTab(windowId);
  store.getState().activate(tabId);
  const afterSwitch = store.getState();
  run(store, { method: "openCommandPanel", windowId, sourceTabId: blank });
  assert.equal(store.getState(), afterSwitch);
  const other = windowWithTab(store);
  assert.throws(() => run(store, { method: "openCommandPanel", windowId, sourceTabId: other.tabId }), { code: "invalid_request" });
});

test("delayed automatic blank-page requests preserve an already open panel session", () => {
  const store = createBrowserStore();
  const { windowId, tabId } = windowWithTab(store);
  run(store, { method: "requestNewTab", windowId });
  const newTabState = store.getState();
  const newTabPanel = newTabState.windowUi[windowId].panel;
  run(store, { method: "openCommandPanel", windowId, sourceTabId: tabId });
  assert.equal(store.getState(), newTabState);
  assert.equal(store.getState().windowUi[windowId].panel, newTabPanel);
  assert.equal(newTabPanel.mode, "newTab");
  run(store, { method: "openCommandPanel", windowId, initialText: "typed address" });
  const navigationState = store.getState();
  const navigationPanel = navigationState.windowUi[windowId].panel;
  run(store, { method: "openCommandPanel", windowId, sourceTabId: tabId });
  assert.equal(store.getState(), navigationState);
  assert.equal(store.getState().windowUi[windowId].panel, navigationPanel);
  assert.equal(navigationPanel.initialText, "typed address");
  assert.notEqual(navigationPanel.sessionId, newTabPanel.sessionId);
});
