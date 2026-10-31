import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { activeTabId } from "../store/model.ts";
import { splitOf } from "../store/splits.ts";
import { createBrowserAuthority } from "./authority.ts";
import { executeSplitCommand, parseSplitCommand, SPLIT_COMMAND_METHODS } from "./splitCommands.ts";

const run = (store, command) => executeSplitCommand(store, parseSplitCommand(command));
function setup() {
  const store = createBrowserStore();
  const s = () => store.getState();
  s().updateSettings({ peekLinksFromPinnedTabs: true });
  const windowId = s().createWindow({ url: "a.com" });
  const a = activeTabId(s(), windowId);
  const b = s().newTab(windowId, { url: "b.com", background: true });
  const privateWindow = s().createWindow({ incognito: true, url: "private.com" });
  return { store, s, windowId, a, b, privateWindow, privateTab: activeTabId(s(), privateWindow) };
}

test("split parser closes commands and excludes native page adoption", () => {
  const commands = [
    { method: "createSplit", tabIds: ["a", "b"], orientation: "vertical" },
    { method: "openSplitPane", windowId: "w", options: { tabId: "t", url: "x.com", anchorTabId: "a", side: "left", background: true } },
    { method: "replaceSplitPane", paneTabId: "p", tabId: "t" },
    { method: "removeTabFromSplit", tabId: "t" },
    ...["separateSplit", "flipSplit", "toggleSplitOrientation"].map((method) => ({ method, splitId: "s" })),
    { method: "updateSplit", splitId: "s", patch: { sizes: [0.25, 0.75], stackSizes: [0.5, 0.5] } },
    { method: "movePane", tabId: "t", delta: 1 },
    { method: "focusPane", windowId: "w", delta: -1 },
    ...["toggleTabLayout", "closePeek", "keepPeek", "splitPeek", "reopenPeekOrClosed"].map((method) => ({ method, windowId: "w" })),
    { method: "openPeek", fromTabId: "t", url: "x.com" },
    { method: "openPeek", fromTabId: "t", url: "x.com", point: { x: 120, y: 80 } },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(SPLIT_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseSplitCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseSplitCommand({ ...command, native: true }), { code: "invalid_request" });
  }
  for (const command of [
    { method: "openSplitPane", windowId: "w", options: { adoptId: "chrome-tab" } },
    { method: "openPeek", fromTabId: "t", url: "x.com", adoptId: "chrome-tab" },
    { method: "openSplitPane", windowId: "w", options: { side: "middle" } },
    { method: "createSplit", tabIds: ["a"] },
    { method: "createSplit", tabIds: ["a", "b", "c", "d"] },
    { method: "createSplit", tabIds: ["a", "a"] },
    { method: "updateSplit", splitId: "s", patch: { sizes: [0, 1] } },
    { method: "updateSplit", splitId: "s", patch: { sizes: [NaN, 0.5] } },
    { method: "updateSplit", splitId: "s", patch: { stackSizes: [0.2, 0.3, 0.5] } },
    { method: "movePane", tabId: "t", delta: 2 },
    { method: "reopenPeek", windowId: "w" },
    ...[{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1 }, { x: 1, y: 2, native: true }].map((point) => ({
      method: "openPeek",
      fromTabId: "t",
      url: "x.com",
      point,
    })),
  ])
    assert.throws(() => parseSplitCommand(command), { code: "invalid_request" }, JSON.stringify(command));
});

test("split commands drive split view and peeks", () => {
  const { store, s, windowId, a, b } = setup();
  const split = run(store, { method: "createSplit", tabIds: [a, b] });
  assert.deepEqual(s().splits[split].tabIds, [a, b]);
  run(store, { method: "flipSplit", splitId: split });
  assert.deepEqual(s().splits[split].tabIds, [b, a]);
  run(store, { method: "toggleSplitOrientation", splitId: split });
  assert.equal(s().splits[split].orientation, "vertical");
  run(store, { method: "updateSplit", splitId: split, patch: { sizes: [0.3, 0.7] } });
  assert.deepEqual(s().splits[split].sizes, [0.3, 0.7]);
  run(store, { method: "movePane", tabId: b, delta: 1 });
  assert.deepEqual(s().splits[split].tabIds, [a, b]);
  s().activate(a, windowId);
  run(store, { method: "focusPane", windowId, delta: 1 });
  assert.equal(activeTabId(s(), windowId), b);
  const pane = run(store, { method: "openSplitPane", windowId, options: { anchorTabId: a, url: "c.com", background: true } });
  assert.equal(splitOf(s(), pane).id, split);
  assert.equal(run(store, { method: "openSplitPane", windowId, options: { anchorTabId: a } }), null, "a full split returns no pane");
  run(store, { method: "removeTabFromSplit", tabId: pane });
  assert.equal(splitOf(s(), pane), undefined);
  run(store, { method: "separateSplit", splitId: split });
  assert.equal(s().splits[split], undefined);

  s().togglePin(a);
  s().activate(a, windowId);
  const peek = run(store, { method: "openPeek", fromTabId: a, url: "https://other.org", point: { x: 120, y: 80 } });
  assert.deepEqual(s().peeks[windowId].at, { x: 120, y: 80 });
  assert.equal(s().peeks[windowId].tabId, peek);
  run(store, { method: "closePeek", windowId });
  assert.equal(s().peeks[windowId], undefined);
  run(store, { method: "reopenPeekOrClosed", windowId });
  assert.equal(s().tabs[s().peeks[windowId].tabId].url, "https://other.org");
  run(store, { method: "keepPeek", windowId });
  assert.equal(s().peeks[windowId], undefined);
  run(store, { method: "toggleTabLayout", windowId });
  assert.equal(s().windows[windowId].tabLayout, "top");
});

test("reopenPeekOrClosed reopens the last closed tab in one commit when no peek is waiting", async () => {
  const { store, s, windowId, b } = setup();
  s().closeTab(b);
  const authority = createBrowserAuthority({ epoch: "split", store });
  const commits = [];
  authority.subscribe((commit) => commits.push(commit.revision));
  await authority.dispatch({ epoch: "split", clientId: "w", requestId: 1, command: { method: "reopenPeekOrClosed", windowId } });
  assert.deepEqual(commits, [1]);
  assert.ok(Object.values(s().tabs).some((tab) => tab.url === "https://b.com"));
  authority.close();
});

test("split commands reject private and missing references without mutating", () => {
  const { store, s, windowId, a, b, privateWindow, privateTab } = setup();
  const split = s().createSplit([a, b]);
  for (const command of [
    { method: "createSplit", tabIds: [a, privateTab] },
    { method: "openSplitPane", windowId, options: { tabId: privateTab } },
    { method: "openSplitPane", windowId: privateWindow, options: { anchorTabId: a } },
    { method: "openSplitPane", windowId: "missing" },
    { method: "replaceSplitPane", paneTabId: a, tabId: privateTab },
    { method: "updateSplit", splitId: "missing", patch: {} },
    { method: "flipSplit", splitId: "missing" },
    { method: "openPeek", fromTabId: "missing", url: "x.com" },
    { method: "closePeek", windowId: "missing" },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before);
  }
  assert.ok(s().splits[split]);
});

test("keepPeek returns and focuses the destination selected by link rules", async () => {
  const { store, s, windowId, a } = setup();
  s().updateSettings({ externalLinkRules: [{ id: "route", pattern: "news.com", matchType: "contains", destination: { kind: "newWindow" } }] });
  run(store, { method: "openPeek", fromTabId: a, url: "https://news.com/story" });
  const focused = [];
  const authority = createBrowserAuthority({ epoch: "peek", store, effects: { focusWindow: (id) => focused.push(id) } });
  const reply = await authority.dispatch({ epoch: "peek", clientId: "w", requestId: 1, command: { method: "keepPeek", windowId } });
  assert.notEqual(reply.value, windowId);
  assert.ok(reply.commit.state.windows[reply.value]);
  assert.deepEqual(focused, [reply.value]);
  authority.close();
});
