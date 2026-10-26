import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId, tabListKey, viewTabIds } from "../store/model.ts";
import { executeTabCommand, parseTabCommand, TAB_COMMAND_METHODS } from "./tabCommands.ts";

const sparseArray = (length) => {
  const array = [];
  array.length = length;
  return array;
};
const run = (store, command) => executeTabCommand(store, parseTabCommand(command));
const setup = (options) => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow(options);
  return { store, windowId, tabId: activeTabId(store.getState(), windowId) };
};

test("tab parser closes user command fields and copies options and ID arrays", () => {
  const commands = [
    { method: "newTab", windowId: "w", options: { url: "", background: true, openerId: "t", spaceId: "s", pinned: false, index: 0 } },
    { method: "activate", tabId: "t", windowId: null },
    { method: "showTab", tabId: "t", windowId: "w" },
    ...["closeTab", "removeTab", "duplicateTab", "togglePin"].map((method) => ({ method, tabId: "t" })),
    { method: "closeTabs", tabIds: ["t"] },
    { method: "navigate", tabId: "t", url: "example.com", options: { userInitiated: false } },
    { method: "moveTab", tabId: "t", toIndex: 0 },
    { method: "activateIndex", windowId: "w", index: -1 },
    { method: "cycle", windowId: "w", delta: -1 },
    { method: "updateTabDetails", tabId: "t", patch: { customTitle: "n", customIcon: null, kept: false } },
    ...["wakeTab", "syncInternalPage", "hideNewTab"].map((method) => ({ method, tabId: "t" })),
    { method: "showNewTab", tabId: "t", first: { url: "https://a.example/", title: "A" } },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(TAB_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseTabCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    if (command.options) assert.notEqual(parsed.options, command.options);
    if (command.tabIds) assert.notEqual(parsed.tabIds, command.tabIds);
    assert.throws(() => parseTabCommand({ ...command, native: true }), { code: "invalid_request" });
  }
  for (const command of [
    null,
    [],
    Object.create(commands[0]),
    ...["updateTab", "updateLive", "navigated", "faviconChanged", "hydrate"].map((method) => ({ method, tabId: "t" })),
    ...["adoptId", "wakeAdoptId", "snapshot", "navigation", "windowId"].map((field) => ({ method: "newTab", windowId: "w", options: { [field]: "forged" } })),
    { method: "newTab", windowId: "w", options: null },
    { method: "newTab", windowId: "w", options: { pinned: 1 } },
    { method: "newTab", windowId: "w", options: { background: "true" } },
    { method: "newTab", windowId: "w", options: { url: "x".repeat(1_048_577) } },
    { method: "navigate", tabId: "t", url: "x", options: { userInitiated: "yes" } },
    { method: "navigate", tabId: "t", url: "x", options: { native: true } },
    { method: "closeTab", tabId: "x".repeat(1025) },
    { method: "closeTabs", tabIds: ["t", "t"] },
    { method: "closeTabs", tabIds: sparseArray(1) },
    { method: "closeTabs", tabIds: [42] },
    ...[NaN, Infinity, -1, 1.5, 1_000_001].map((toIndex) => ({ method: "moveTab", tabId: "t", toIndex })),
    { method: "activateIndex", windowId: "w", index: -2 },
    { method: "cycle", windowId: "w", delta: 0 },
  ])
    assert.throws(() => parseTabCommand(command), { code: "invalid_request" });
});

test("tab commands execute user actions and preserve reducer return values", () => {
  const { store, windowId, tabId } = setup({ url: "first.com" });
  const next = run(store, { method: "newTab", windowId, options: { url: "second.com", background: true, openerId: tabId } });
  assert.equal(store.getState().tabs[next].openerId, tabId);
  assert.equal(activeTabId(store.getState(), windowId), tabId);
  assert.equal(run(store, { method: "activate", tabId: next, windowId }), null);
  assert.equal(activeTabId(store.getState(), windowId), next);
  run(store, { method: "navigate", tabId: next, url: "next.com", options: { userInitiated: false } });
  assert.equal(store.getState().tabs[next].navigation.url, "https://next.com");
  assert.equal(store.getState().tabs[next].navigation.userInitiated, undefined);
  const copy = run(store, { method: "duplicateTab", tabId: next });
  assert.equal(store.getState().tabs[copy].adoptId, `clone:${next}`);
  run(store, { method: "togglePin", tabId: copy });
  assert.equal(store.getState().tabs[copy].pinned, true);
  run(store, { method: "togglePin", tabId: copy });
  run(store, { method: "moveTab", tabId: copy, toIndex: 0 });
  assert.equal(store.getState().tabLists[tabListKey(store.getState(), store.getState().tabs[copy])][0], copy);
  run(store, { method: "activateIndex", windowId, index: -1 });
  assert.equal(activeTabId(store.getState(), windowId), viewTabIds(store.getState(), windowId).at(-1));
  run(store, { method: "cycle", windowId, delta: 1 });
  assert.equal(activeTabId(store.getState(), windowId), viewTabIds(store.getState(), windowId)[0]);
  run(store, { method: "closeTab", tabId: next });
  assert.equal(store.getState().tabs[next], undefined);
  run(store, { method: "removeTab", tabId: copy });
  assert.equal(store.getState().tabs[copy], undefined);
  const a = run(store, { method: "newTab", windowId });
  const b = run(store, { method: "newTab", windowId });
  run(store, { method: "closeTabs", tabIds: [a, b] });
  assert.equal(store.getState().tabs[a], undefined);
  assert.equal(store.getState().tabs[b], undefined);
});

test("tab commands validate every reference before invoking any reducer", () => {
  const { store, windowId, tabId } = setup({ url: "public.com" });
  const privateWindow = store.getState().createWindow({ incognito: true, url: "private.com" });
  const privateTab = activeTabId(store.getState(), privateWindow);
  const otherPrivate = store.getState().createWindow({ incognito: true });
  const small = store.getState().createWindow({ small: true });
  for (const command of [
    { method: "newTab", windowId: "missing" },
    { method: "newTab", windowId, options: { spaceId: "missing" } },
    { method: "newTab", windowId, options: { spaceId: store.getState().windows[privateWindow].spaceId } },
    { method: "newTab", windowId: privateWindow, options: { spaceId: "default" } },
    { method: "newTab", windowId, options: { openerId: "missing" } },
    { method: "newTab", windowId, options: { openerId: privateTab } },
    { method: "closeTabs", tabIds: [tabId, "missing"] },
    { method: "activate", tabId, windowId: privateWindow },
    { method: "activate", tabId: privateTab, windowId },
    { method: "activate", tabId: privateTab, windowId: otherPrivate },
    { method: "activate", tabId, windowId: small },
    { method: "navigate", tabId: "missing", url: "next.com" },
    { method: "activateIndex", windowId: "missing", index: 0 },
  ]) {
    const before = store.getState();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(store.getState(), before);
  }
  run(store, { method: "activate", tabId: privateTab, windowId: privateWindow });
  assert.equal(activeTabId(store.getState(), privateWindow), privateTab);
});

test("tab commands invoke the chosen reducer once and use the passed store", () => {
  const { store, windowId, tabId } = setup();
  const calls = [];
  store.setState({ navigate: (...args) => calls.push(args) });
  run(store, { method: "navigate", tabId, url: "example.com" });
  assert.deepEqual(calls, [[tabId, "example.com", undefined]]);
  const foreignSpace = store.getState().createSpace({ name: "Other" });
  const id = run(store, { method: "newTab", windowId, options: { spaceId: foreignSpace, pinned: true, index: 0 } });
  assert.equal(store.getState().tabs[id].spaceId, foreignSpace);
  assert.equal(store.getState().tabs[id].pinned, true);
});

test("showTab focuses its actual owner once while activate preserves focus", () => {
  const { store, windowId, tabId } = setup({ url: "first.com" });
  const other = store.getState().createWindow({ url: "second.com" });
  const focused = [];
  const effects = { focusWindow: (id) => focused.push(id) };
  executeTabCommand(store, parseTabCommand({ method: "activate", tabId, windowId }), effects);
  assert.equal(store.getState().ui.focusedWindowId, other);
  assert.deepEqual(focused, []);
  executeTabCommand(store, parseTabCommand({ method: "showTab", tabId, windowId }), effects);
  assert.equal(store.getState().ui.focusedWindowId, windowId);
  assert.deepEqual(focused, [windowId]);
  executeTabCommand(store, parseTabCommand({ method: "showTab", tabId, windowId }), effects);
  assert.deepEqual(focused, [windowId]);
});

test("newTab preserves the empty result for an app URL handled outside tabs", () => {
  const routed = [];
  const store = createBrowserStore({
    openAppUrl: (url, windowId) => {
      routed.push([url, windowId]);
      return true;
    },
  });
  const windowId = store.getState().createWindow();
  const before = store.getState();
  assert.equal(run(store, { method: "newTab", windowId, options: { url: "yahu://newtab" } }), "");
  assert.deepEqual(routed, [["yahu://newtab", windowId]]);
  assert.equal(store.getState(), before);
});

test("showTab without a destination focuses the live owner instead of stealing its page", () => {
  const { store, windowId, tabId } = setup({ url: "first.com" });
  const other = store.getState().createWindow({ url: "second.com" });
  const focused = [];
  assert.equal(store.getState().ui.focusedWindowId, other);
  executeTabCommand(store, parseTabCommand({ method: "showTab", tabId }), { focusWindow: (id) => focused.push(id) });
  assert.equal(store.getState().tabs[tabId].windowId, windowId);
  assert.equal(store.getState().ui.focusedWindowId, windowId);
  assert.deepEqual(focused, [windowId]);
});

test("a New Tab page shown by Back keeps its page in the tab until the page goes elsewhere", () => {
  const { store, tabId } = setup({ url: "https://a.example/" });
  store.getState().navigated(tabId, { url: "https://a.example/", title: "A" }, {});
  store.getState().faviconChanged(tabId, "https://a.example/icon.png");
  run(store, { method: "showNewTab", tabId });
  let tab = store.getState().tabs[tabId];
  assert.equal(tab.url, "");
  assert.deepEqual(tab.newTabHistory, { url: "https://a.example/", title: "A", favicon: "https://a.example/icon.png" });
  // The kept page's own reports refresh what Forward returns to, not the New Tab page.
  store.getState().navigated(tabId, { url: "https://a.example/", title: "A2" }, {});
  store.getState().faviconChanged(tabId, "https://a.example/2.png");
  tab = store.getState().tabs[tabId];
  assert.equal(tab.url, "");
  assert.deepEqual(tab.newTabHistory, { url: "https://a.example/", title: "A2", favicon: "https://a.example/2.png" });
  run(store, { method: "hideNewTab", tabId });
  tab = store.getState().tabs[tabId];
  assert.equal(tab.url, "https://a.example/");
  assert.equal(tab.title, "A2");
  assert.equal(tab.newTabHistory, undefined);
  run(store, { method: "showNewTab", tabId });
  store.getState().navigated(tabId, { url: "https://b.example/", title: "B" }, {});
  tab = store.getState().tabs[tabId];
  assert.equal(tab.url, "https://b.example/");
  assert.equal(tab.newTabHistory, undefined);
  run(store, { method: "showNewTab", tabId });
  store.getState().navigate(tabId, "https://c.example/");
  assert.equal(store.getState().tabs[tabId].newTabHistory, undefined);
});

test("syncInternalPage handles Library and derives an Easel title from library data", async () => {
  const { useLibrary } = await import("../components/library/state.ts");
  const { store, windowId, tabId } = setup({ url: "bay://library" });
  run(store, { method: "syncInternalPage", tabId });
  assert.equal(store.getState().tabs[tabId].title, "Library");
  const spaceId = store.getState().windows[windowId].spaceId;
  const prior = useLibrary.getState();
  try {
    useLibrary.setState({ easels: { "easel one": { id: "easel one", spaceId, title: "Project notes" } } });
    store.getState().navigate(tabId, "bay://easel/easel%20one");
    run(store, { method: "syncInternalPage", tabId });
    assert.equal(store.getState().tabs[tabId].title, "Project notes");
    useLibrary.setState({ easels: { "easel one": { id: "easel one", spaceId: "other", title: "Hidden" } } });
    run(store, { method: "syncInternalPage", tabId });
    assert.equal(store.getState().tabs[tabId].title, "Easel");
    store.getState().navigate(tabId, "bay://easel/%E0%A4%A");
    run(store, { method: "syncInternalPage", tabId });
    assert.equal(store.getState().tabs[tabId].title, "Easel");
  } finally {
    useLibrary.setState(prior);
  }
});
