import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId } from "../store/model.ts";
import { executeWindowCommand, parseWindowCommand, WINDOW_COMMAND_METHODS } from "./windowCommands.ts";

const sparseArray = (length) => {
  const array = [];
  array.length = length;
  return array;
};
const run = (store, command) => executeWindowCommand(store, parseWindowCommand(command));
const setup = (options) => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow(options);
  return { store, windowId, tabId: activeTabId(store.getState(), windowId) };
};

test("window parser accepts bounded user options and rejects native facts", () => {
  const commands = [
    {
      method: "createWindow",
      options: {
        spaceId: "s",
        url: "",
        incognito: false,
        tabIds: ["t"],
        frame: [-10, 20, 800, 600],
        size: [800, 600],
        maximized: true,
        small: false,
        background: true,
      },
    },
    ...["closeWindow", "toggleSidebar", "mergeAllWindows", "focusWindow", "openInMainWindow"].map((method) => ({ method, windowId: "w" })),
    { method: "switchSpace", windowId: "w", spaceId: "s" },
    { method: "moveTabsToWindow", tabIds: ["t"], windowId: null },
    { method: "moveTabToSpace", tabId: "t", spaceId: "s" },
    { method: "reopenClosed", windowId: null },
    { method: "reopenClosedTab", windowId: "w" },
    { method: "reopenClosedWindow" },
    { method: "restoreClosed", entryId: "entry", windowId: "w" },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(WINDOW_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseWindowCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseWindowCommand({ ...command, native: true }), { code: "invalid_request" });
  }
  assert.notEqual(parseWindowCommand(commands[0]).options.tabIds, commands[0].options.tabIds);
  assert.notEqual(parseWindowCommand(commands[0]).options.frame, commands[0].options.frame);
  assert.notEqual(parseWindowCommand(commands[0]).options.size, commands[0].options.size);
  for (const command of [
    null,
    [],
    Object.create(commands[0]),
    { method: "setWindowFrame", windowId: "w", frame: [0, 0, 800, 600] },
    { method: "setFocusedWindow", windowId: "w" },
    { method: "createWindow", options: { adoptId: "native" } },
    { method: "createWindow", options: { activeTabIds: {} } },
    { method: "createWindow", options: { incognito: "true" } },
    ...[[0, 0, 1], [0, 0, -1, 1], [0, 0, 0, 1], [Infinity, 0, 1, 1], [0, 0, NaN, 1], sparseArray(4), [1_000_001, 0, 1, 1]].map((frame) => ({
      method: "createWindow",
      options: { frame },
    })),
    { method: "moveTabsToWindow", tabIds: ["t", "t"], windowId: "w" },
    { method: "moveTabsToWindow", tabIds: sparseArray(1), windowId: "w" },
    { method: "moveTabsToWindow", tabIds: ["t"] },
    { method: "switchSpace", windowId: "", spaceId: "s" },
    { method: "restoreClosed", entryId: "" },
    { method: "reopenClosedWindow", windowId: "w" },
  ])
    assert.throws(() => parseWindowCommand(command), { code: "invalid_request" });
});

test("window commands create, move, switch and merge through the existing reducers", () => {
  const { store, windowId, tabId } = setup({ url: "first.com" });
  const spaceId = store.getState().createSpace({ name: "Work" });
  const target = run(store, { method: "createWindow", options: { spaceId, url: "second.com", frame: [1, 2, 800, 600], background: true } });
  assert.equal(store.getState().windows[target].spaceId, spaceId);
  assert.deepEqual(store.getState().windows[target].frame, [1, 2, 800, 600]);
  assert.equal(store.getState().ui.focusedWindowId, windowId);
  run(store, { method: "toggleSidebar", windowId: target });
  assert.equal(store.getState().windows[target].sidebarOpen, false);
  assert.equal(run(store, { method: "moveTabsToWindow", tabIds: [tabId], windowId: target }), target);
  assert.equal(store.getState().tabs[tabId].windowId, target);
  run(store, { method: "moveTabToSpace", tabId, spaceId });
  assert.equal(store.getState().tabs[tabId].spaceId, spaceId);
  run(store, { method: "switchSpace", windowId, spaceId });
  assert.equal(store.getState().windows[windowId].spaceId, spaceId);
  run(store, { method: "mergeAllWindows", windowId });
  assert.deepEqual(store.getState().windowOrder, [windowId]);
  assert.equal(store.getState().tabs[tabId].windowId, windowId);
  const detached = run(store, { method: "moveTabsToWindow", tabIds: [tabId], windowId: null });
  assert.equal(store.getState().tabs[tabId].windowId, detached);
  run(store, { method: "closeWindow", windowId: detached });
  assert.equal(store.getState().windows[detached], undefined);
  assert.equal(store.getState().tabs[tabId].windowId, "");
});

test("window restore commands retain closed tabs and windows", () => {
  const { store, windowId } = setup({ url: "first.com" });
  const closeTab = () => {
    const id = store.getState().newTab(windowId, { url: "closed.com" });
    store.getState().closeTab(id);
    return store.getState().closedTabs.at(-1).id;
  };
  closeTab();
  const count = Object.keys(store.getState().tabs).length;
  run(store, { method: "reopenClosedTab", windowId });
  assert.equal(Object.keys(store.getState().tabs).length, count + 1);
  const entryId = closeTab();
  run(store, { method: "restoreClosed", entryId, windowId });
  assert.equal(
    store.getState().closedTabs.some((entry) => entry.id === entryId),
    false,
  );
  closeTab();
  run(store, { method: "reopenClosed", windowId });
  assert.equal(store.getState().closedTabs.length, 0);
  const other = store.getState().createWindow({ url: "other.com" });
  run(store, { method: "closeWindow", windowId: other });
  run(store, { method: "reopenClosedWindow" });
  assert.equal(store.getState().closedWindows.length, 0);
  assert.equal(store.getState().windowOrder.length, 2);
});

test("window commands reject invalid and private references before any changes", () => {
  const { store, windowId, tabId } = setup({ url: "public.com" });
  const privateWindow = store.getState().createWindow({ incognito: true, url: "private.com" });
  const privateTab = activeTabId(store.getState(), privateWindow);
  const otherPrivate = store.getState().createWindow({ incognito: true });
  const small = store.getState().createWindow({ small: true });
  const closed = store.getState().newTab(windowId, { url: "closed.com" });
  store.getState().closeTab(closed);
  const entryId = store.getState().closedTabs.at(-1).id;
  for (const command of [
    { method: "createWindow", options: { spaceId: "missing" } },
    { method: "createWindow", options: { incognito: true, tabIds: [tabId] } },
    { method: "createWindow", options: { tabIds: [privateTab] } },
    { method: "createWindow", options: { tabIds: [tabId, "missing"] } },
    { method: "createWindow", options: { small: true, tabIds: [tabId] } },
    { method: "moveTabsToWindow", tabIds: [tabId, "missing"], windowId },
    { method: "moveTabsToWindow", tabIds: [privateTab], windowId },
    { method: "moveTabsToWindow", tabIds: [privateTab], windowId: null },
    { method: "moveTabsToWindow", tabIds: [tabId], windowId: privateWindow },
    { method: "moveTabsToWindow", tabIds: [privateTab], windowId: otherPrivate },
    { method: "moveTabsToWindow", tabIds: [tabId], windowId: small },
    { method: "moveTabToSpace", tabId: privateTab, spaceId: "default" },
    { method: "moveTabToSpace", tabId, spaceId: "missing" },
    { method: "switchSpace", windowId: privateWindow, spaceId: "default" },
    { method: "closeWindow", windowId: "missing" },
    { method: "restoreClosed", entryId: "missing", windowId },
    { method: "restoreClosed", entryId, windowId: privateWindow },
  ]) {
    const before = store.getState();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(store.getState(), before);
  }
  run(store, { method: "moveTabsToWindow", tabIds: [privateTab], windowId: privateWindow });
  assert.equal(store.getState().tabs[privateTab].windowId, privateWindow);
});

test("window command invokes the selected reducer once and normalizes optional results", () => {
  const { store, windowId, tabId } = setup();
  const calls = [];
  store.setState({
    moveTabsToWindow: (...args) => {
      calls.push(args);
      return undefined;
    },
  });
  assert.equal(run(store, { method: "moveTabsToWindow", tabIds: [tabId], windowId }), null);
  assert.deepEqual(calls, [[[tabId], windowId]]);
});

test("focusWindow updates authority focus before invoking its native effect", () => {
  const { store, windowId } = setup();
  store.getState().createWindow();
  const focused = [];
  executeWindowCommand(store, parseWindowCommand({ method: "focusWindow", windowId }), {
    focusWindow(id) {
      assert.equal(store.getState().ui.focusedWindowId, id);
      focused.push(id);
    },
  });
  assert.deepEqual(focused, [windowId]);
  assert.throws(
    () => executeWindowCommand(store, parseWindowCommand({ method: "focusWindow", windowId: "missing" }), { focusWindow: (id) => focused.push(id) }),
    { code: "invalid_request" },
  );
  assert.deepEqual(focused, [windowId]);
});

test("Little Bay moves into or creates its main window before its source can disappear", () => {
  for (const url of ["", "https://moving.example/"]) {
    for (const existing of [false, true]) {
      const store = createBrowserStore();
      const main = existing ? store.getState().createWindow({ url: "https://main.example/" }) : null;
      const small = store.getState().createWindow({ small: true, url });
      const tabId = activeTabId(store.getState(), small);
      const focused = [];
      assert.equal(
        executeWindowCommand(store, parseWindowCommand({ method: "openInMainWindow", windowId: small }), {
          focusWindow(id) {
            assert.equal(store.getState().windows[small], undefined);
            assert.ok(store.getState().windows[id]);
            assert.equal(store.getState().ui.focusedWindowId, id);
            focused.push(id);
          },
        }),
        null,
      );
      assert.equal(store.getState().windowOrder.length, 1);
      const target = store.getState().windowOrder[0];
      if (main) assert.equal(target, main);
      assert.deepEqual(focused, [target]);
      if (url) assert.equal(store.getState().tabs[tabId].windowId, target);
    }
  }
  const { store, windowId } = setup();
  const before = store.getState();
  assert.throws(() => run(store, { method: "openInMainWindow", windowId }), { code: "invalid_request" });
  assert.equal(store.getState(), before);
});

test("window size/maximized command fields are strict and native placement setters stay private", () => {
  for (const size of [[], [1], [1, 2, 3], [0, 1], [-1, 1], [1, Infinity], [1, NaN], [1, "2"], sparseArray(2), null, { width: 1, height: 2 }]) {
    assert.throws(() => parseWindowCommand({ method: "createWindow", options: { size } }), { code: "invalid_request" });
  }
  for (const options of [{ maximized: 1 }, { minimized: true }, { fullscreen: true }, { size: [1, 2], position: [1, 2] }]) {
    assert.throws(() => parseWindowCommand({ method: "createWindow", options }), { code: "invalid_request" });
  }
  assert.throws(() => parseWindowCommand({ method: "setWindowPlacement", windowId: "w", placement: { size: [1, 2], maximized: true } }), {
    code: "invalid_request",
  });
});
