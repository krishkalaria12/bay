import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { bookmarkDbs, docs, heldSaves, historyWatches } from "../test-native-stub.mjs";
import { createPersistence, flushPersistence, resumePersistence, startPersistence } from "./persist.ts";

test("final persistence waits for disk acknowledgements and freezes closing windows", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  heldSaves.on = true;
  try {
    const windowId = useBrowser.getState().createWindow({ url: "https://saved.example/" });
    let done = false;
    const final = flushPersistence({ final: true }).then(() => { done = true; });
    assert.equal(heldSaves.queue.length, 2);
    useBrowser.getState().closeWindow(windowId);
    assert.strictEqual(flushPersistence({ final: true }), flushPersistence({ final: true }));
    await Promise.resolve();
    assert.equal(done, false);
    heldSaves.queue.splice(0).forEach(release => release());
    await final;
    assert.equal(done, true);
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
    heldSaves.on = false;
    resumePersistence();
    assert.equal(JSON.parse(docs.get("session.json")).windows.length, 0);
  } finally {
    heldSaves.on = false;
    heldSaves.queue.splice(0).forEach(release => release());
    resumePersistence();
    stop();
  }
});

test("failed final writes reject quit and can be saved after cancellation", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  try {
    const windowId = useBrowser.getState().createWindow({ url: "https://retry.example/" });
    heldSaves.error = new Error("disk full");
    await assert.rejects(flushPersistence({ final: true }), /disk full/);
    heldSaves.error = null;
    resumePersistence();
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
    await flushPersistence({ final: true });
  } finally {
    heldSaves.error = null;
    resumePersistence();
    stop();
  }
});

test("a final save acknowledged after cancellation cannot replace the newer save cache", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  heldSaves.on = true;
  try {
    useBrowser.getState().createWindow({ url: "https://cancel.example/" });
    const final = flushPersistence({ final: true });
    useBrowser.getState().updateSettings({ appearance: "dark" });
    resumePersistence();
    const newer = docs.get("session.json");
    heldSaves.queue.splice(0).forEach(release => release());
    await final;
    // Native's newer write is ordered after the pending final save.
    docs.set("session.json", newer);
    useBrowser.getState().updateSettings({ appearance: "auto" });
    await flushPersistence();
    assert.equal(JSON.parse(docs.get("session.json")).settings.appearance, "auto");
  } finally {
    heldSaves.on = false;
    heldSaves.queue.splice(0).forEach(release => release());
    resumePersistence();
    stop();
  }
});

test("an explicit owner restores only its store and starts no global data services", async () => {
  docs.clear();
  const seed = createBrowserStore();
  const windowId = seed.getState().createWindow({ url: "https://restored.example/" });
  const seedOwner = createPersistence({ store: seed, restoreSession: false });
  await seedOwner.flush({ final: true }); seedOwner.dispose();
  // Let callbacks from the preceding compatibility-wrapper tests finish first.
  await new Promise(setImmediate);
  const original = useBrowser.getState(), watches = historyWatches.length, bookmarkProfiles = bookmarkDbs.size;
  const store = createBrowserStore(), owner = createPersistence({ store });
  try {
    assert.ok(store.getState().windows[windowId]);
    assert.equal(store.getState().tabs[store.getState().windows[windowId].tabIds[0]].url, "https://restored.example/");
    await new Promise(setImmediate);
    assert.equal(useBrowser.getState(), original);
    assert.equal(historyWatches.length, watches);
    assert.equal(bookmarkDbs.size, bookmarkProfiles);
  } finally { owner.dispose(); }
});

test("recovery persistence skips hydrate and preserves accepted native and UI state", async () => {
  docs.clear(); docs.set("session.json", "invalid stale disk session");
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://live.example/" }), tabId = store.getState().windows[windowId].tabIds[0];
  store.getState().updateTab(tabId, { adoptId: "native-page-42" }, { progress: 0.7, isLoading: true });
  store.getState().openPanel(windowId, "retained query");
  let hydrated = 0;
  store.setState({ hydrate() { hydrated++; throw new Error("recovery must not hydrate"); } });
  const accepted = store.getState(), owner = createPersistence({ store, restoreSession: false });
  try {
    assert.equal(store.getState(), accepted);
    await owner.flush({ final: true });
    assert.equal(hydrated, 0);
    assert.equal(store.getState().tabs[tabId].adoptId, "native-page-42");
    assert.equal(store.getState().tabs[tabId].navigation, accepted.tabs[tabId].navigation);
    assert.equal(store.getState().live[tabId].progress, 0.7);
    assert.equal(store.getState().windowUi[windowId].panel.initialText, "retained query");
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
  } finally { owner.dispose(); }
});

test("one owner's final freeze does not freeze another owner or its resume", async () => {
  docs.clear();
  const a = createBrowserStore(), b = createBrowserStore();
  const ownerA = createPersistence({ store: a, restoreSession: false }), ownerB = createPersistence({ store: b, restoreSession: false });
  try {
    const windowA = a.getState().createWindow({ url: "https://a.example/" });
    const frozen = ownerA.flush({ final: true }); await frozen;
    a.getState().closeWindow(windowA);
    const windowB = b.getState().createWindow({ url: "https://b.example/" });
    await ownerB.flush();
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowB);
    assert.equal(ownerA.flush({ final: true }), frozen);
    ownerA.resume(); assert.equal(JSON.parse(docs.get("session.json")).windows.length, 0);
    b.getState().updateSettings({ appearance: "dark" }); await ownerB.flush();
    assert.equal(JSON.parse(docs.get("session.json")).settings.appearance, "dark");
  } finally { ownerA.dispose(); ownerB.dispose(); }
});

test("disposal cancels only its timer and subscription", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  docs.clear();
  const a = createBrowserStore(), b = createBrowserStore();
  const ownerA = createPersistence({ store: a, restoreSession: false }), ownerB = createPersistence({ store: b, restoreSession: false });
  try {
    a.getState().createWindow({ url: "https://cancelled.example/" }); context.mock.timers.tick(400);
    ownerA.dispose(); ownerA.dispose();
    const windowB = b.getState().createWindow({ url: "https://saved.example/" });
    context.mock.timers.tick(400); assert.equal(docs.has("session.json"), false);
    context.mock.timers.tick(400); assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowB);
    ownerB.dispose(); const saved = docs.get("session.json");
    b.getState().closeWindow(windowB); ownerB.resume(); context.mock.timers.tick(1000);
    assert.equal(docs.get("session.json"), saved);
    await assert.rejects(ownerA.flush(), /disposed/); await assert.rejects(ownerB.flush({ final: true }), /disposed/);
  } finally { ownerA.dispose(); ownerB.dispose(); context.mock.timers.reset(); }
});

test("late acknowledgements from a disposed owner cannot alter its replacement's save cache", async () => {
  docs.clear();
  const store = createBrowserStore(), old = createPersistence({ store, restoreSession: false });
  store.getState().createWindow({ url: "https://replace.example/" }); heldSaves.on = true;
  const pending = old.flush({ final: true }); old.dispose();
  const replacement = createPersistence({ store, restoreSession: false });
  try {
    store.getState().updateSettings({ appearance: "dark" }); await replacement.flush();
    const newer = docs.get("session.json");
    heldSaves.queue.splice(0).forEach((release) => release()); await pending;
    // Production queues the newer write after the old save. Reproduce that disk
    // order while leaving both owners' completion/cache callbacks untouched.
    docs.set("session.json", newer);
    store.getState().updateSettings({ appearance: "auto" }); await replacement.flush();
    assert.equal(JSON.parse(docs.get("session.json")).settings.appearance, "auto");
    old.resume(); await assert.rejects(old.flush(), /disposed/);
  } finally {
    heldSaves.on = false; heldSaves.queue.splice(0).forEach((release) => release()); replacement.dispose();
  }
});
