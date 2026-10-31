import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { startCoordinatorServices } from "./services.ts";
import { AUTO_CLEAN_EVERY_MS } from "../lib/constants.ts";
import { live, updateConfig } from "../live/store.ts";
import { appEventListeners, windowEventListeners, calendarChangedListeners, docs, emitAppEvent, heldSaves } from "../test-native-stub.mjs";

const tick = () => new Promise(setImmediate);
const listeners = () => [appEventListeners.size, windowEventListeners.size, calendarChangedListeners.size];

test("one authority owns cleanup and data services across its windows, and disposal removes them", async (t) => {
  docs.clear();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = createBrowserStore();
  store.getState().createWindow();
  store.getState().createWindow();
  const legacy = useBrowser.getState();
  const before = listeners();
  let cleaned = 0,
    abandoned = 0;
  store.setState({
    cleanUpInactiveTabs() {
      cleaned++;
      return 0;
    },
    closeAbandonedNewTabs() {
      abandoned++;
    },
  });
  const owner = startCoordinatorServices({ store });
  t.after(() => owner.dispose());
  assert.equal(startCoordinatorServices({ store }), owner);
  emitAppEvent({ type: "resignActive" });
  emitAppEvent({ type: "screenLocked" });
  assert.equal(abandoned, 2);
  t.mock.timers.tick(AUTO_CLEAN_EVERY_MS);
  assert.equal(cleaned, 1);
  await tick();
  assert.equal(useBrowser.getState(), legacy);
  owner.dispose();
  owner.dispose();
  assert.deepEqual(listeners(), before);
  const writes = t.mock.method(docs, "set");
  store.getState().updateSettings({ sidebarWidth: 345 });
  updateConfig({ githubClientId: "after-dispose" });
  emitAppEvent({ type: "resignActive" });
  t.mock.timers.tick(AUTO_CLEAN_EVERY_MS);
  await tick();
  assert.equal(abandoned, 2);
  assert.equal(cleaned, 1);
  assert.equal(writes.mock.callCount(), 0);
  await assert.rejects(owner.flush(), /disposed/);
});

test("background persistence preserves recovered state and acknowledges both final documents before resuming", async (t) => {
  docs.clear();
  docs.set("session.json", "stale disk session");
  docs.set("live.json", JSON.stringify({ config: { githubClientId: "saved-live" } }));
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://accepted.example/" });
  const tabId = Object.keys(store.getState().tabs)[0];
  store.getState().updateTab(tabId, { adoptId: "native-page" }, { progress: 0.7 });
  const hydrate = t.mock.method(store.getState(), "hydrate");
  const owner = startCoordinatorServices({ store });
  t.after(() => {
    owner.dispose();
    heldSaves.on = false;
    heldSaves.queue.length = 0;
  });
  assert.equal(hydrate.mock.callCount(), 0);
  assert.equal(live().config.githubClientId, "saved-live");
  assert.equal(store.getState().tabs[tabId].adoptId, "native-page");
  assert.equal(store.getState().live[tabId].progress, 0.7);
  await tick();
  heldSaves.on = true;
  let acknowledged = false;
  const final = owner.flush({ final: true }).then(() => {
    acknowledged = true;
  });
  assert.equal(heldSaves.queue.length, 3, "session, downloads and Live all use acknowledged saves");
  store.getState().closeWindow(windowId);
  updateConfig({ githubClientId: "changed-during-quit" });
  heldSaves.queue.shift()();
  await tick();
  assert.equal(acknowledged, false);
  heldSaves.queue.splice(0).forEach((release) => release());
  await final;
  assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
  assert.equal(JSON.parse(docs.get("live.json")).config.githubClientId, "saved-live");
  heldSaves.on = false;
  owner.resume();
  assert.equal(JSON.parse(docs.get("session.json")).windows.length, 0);
  assert.equal(JSON.parse(docs.get("live.json")).config.githubClientId, "changed-during-quit");
});
