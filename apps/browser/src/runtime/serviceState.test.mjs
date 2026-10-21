import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.__DEV__ = false;
const { createBrowserStore, useBrowser } = await import("../store/browser.ts");
const { startServiceStateOwner, installServiceState } = await import("./serviceState.ts");
const { executeServiceCommand } = await import("./serviceExecutor.ts");
const { parseServiceCommand } = await import("./serviceCommands.ts");
const { live, setLive, setLiveView } = await import("../live/store.ts");
const command = (action, args = []) => parseServiceCommand({ method: "serviceAction", action, args });
test("coordinator snapshots detach remote mirrors and stop publishing", () => {
  const browser = createBrowserStore();
  browser.getState().hydrate({});
  const stop = startServiceStateOwner(browser, { restore: false });
  const snapshot = browser.getState().services;
  assert.ok(snapshot.live);
  assert.ok(snapshot.calendar);
  assert.ok(snapshot.alerts);
  assert.ok(snapshot.sync);
  assert.ok(snapshot.telemetry);
  assert.equal("scopes" in snapshot.sync, false);
  assert.equal("deviceId" in snapshot.sync, false);
  stop();
  setLiveView("showAll", "after-stop", true);
  assert.equal(browser.getState().services, snapshot);
  installServiceState(snapshot);
  assert.deepEqual(live(), snapshot.live);
  assert.notEqual(live(), snapshot.live);
  setLiveView("showAll", "detached", true);
  assert.equal(snapshot.live.showAll.detached, undefined);
});
test("service browser mutations use the explicit authority and reject private requests", async () => {
  const browser = createBrowserStore();
  browser.getState().hydrate({});
  const windowId = browser.getState().createWindow();
  const stop = startServiceStateOwner(browser, { restore: false });
  const singleton = useBrowser.getState();
  try {
    setLive({ accounts: {}, folders: {}, folderOrder: [], items: {}, status: {}, unread: {}, known: {}, completing: {}, completed: {} });
    const folderId = await executeServiceCommand(browser, command("liveCreate", [windowId, "documents"]));
    assert.equal(live().folders[folderId].spaceId, browser.getState().windows[windowId].spaceId);
    const item = { id: "notion:page", source: "notion", url: "https://example.com/doc", title: "Doc", subtitle: "", icon: null, updatedAt: 1 };
    setLive((s) => ({ items: { ...s.items, [folderId]: [item] } }));
    const tabId = await executeServiceCommand(browser, command("liveOpen", [windowId, folderId, item.id, false]));
    assert.equal(browser.getState().tabs[tabId].url, item.url);
    assert.deepEqual(browser.getState().tabs[tabId].liveItem, { folderId, itemId: item.id });
    assert.equal(useBrowser.getState(), singleton);
    const privateId = browser.getState().createWindow({ incognito: true });
    await assert.rejects(executeServiceCommand(browser, command("liveCreate", [privateId, "documents"])), { code: "invalid_request" });
  } finally {
    stop();
  }
});
