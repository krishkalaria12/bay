import assert from "node:assert/strict";
import { test } from "node:test";

const timers = new Map();
let timerId = 0;
globalThis.__DEV__ = false;
globalThis.setTimeout = (run) => {
  const id = ++timerId;
  timers.set(id, run);
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
let statusRead = async () => "ok";
let readListing = async () => ({ files: [], pending: [], damaged: [], present: [] });
let nativeWrites = 0;
let picked = "/picked";
globalThis.nnTestNativeModules = {
  BaySync: {
    newDeviceId: () => "device",
    deviceName: () => "Test",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: () => statusRead(),
    write: async () => {
      nativeWrites++;
      return "file";
    },
    read: (...args) => readListing(...args),
    remove: async () => {},
    sealLocal: async (value) => value,
    openLocal: async (value) => value,
    readPasswords: async () => null,
    chooseFolder: async () => picked,
    folderInfo: async (path) => ({ path }),
  },
};
const { createBrowserStore, useBrowser } = await import("../store/browser.ts");
const shell = await import("@bay/shell");
const { installServiceClient } = await import("../runtime/serviceClient.ts");
const engine = await import("./engine.ts");
const { settingsAdapter } = await import("./adapters.ts");
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};

test("sync owns an explicit store and disposal stops subscription, timers and suspended cycles", async () => {
  shell.docs.clear();
  const owner = createBrowserStore();
  const legacy = useBrowser.getState();
  const dispose = engine.startSync(owner);
  await engine.turnOnSync("/sync");
  settingsAdapter.apply(new Map([["set:searchEngine", { v: "duckduckgo" }]]), new Set(["set:searchEngine"]));
  assert.equal(owner.getState().settings.searchEngine, "duckduckgo");
  assert.equal(useBrowser.getState(), legacy, "remote adapters write only to the explicit owner");
  let release;
  statusRead = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const cycle = engine.syncNow();
  await settle();
  assert.equal(typeof release, "function");
  dispose();
  const ui = engine.useSync.getState();
  const writes = nativeWrites;
  const disk = [...shell.docs];
  owner.getState().updateSettings({ searchEngine: "duckduckgo" });
  assert.equal(timers.size, 0, "all timers are cleared after dispose");
  release("ok");
  await cycle;
  assert.equal(nativeWrites, writes, "a stopped cycle does not publish files");
  assert.deepEqual([...shell.docs], disk, "a stopped cycle does not save metadata");
  assert.equal(engine.useSync.getState(), ui, "a stopped cycle does not publish UI");
  assert.equal(useBrowser.getState(), legacy, "the mutable legacy singleton is untouched");
  statusRead = async () => "ok";
});

test("a suspended folder read and an old disposer cannot change a replacement owner", async () => {
  shell.docs.clear();
  const first = createBrowserStore();
  const disposeFirst = engine.startSync(first);
  await engine.turnOnSync("/sync");
  let release;
  readListing = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const cycle = engine.syncNow();
  await settle();
  assert.equal(typeof release, "function");
  disposeFirst();
  const second = createBrowserStore();
  const disposeSecond = engine.startSync(second);
  await settle();
  const state = second.getState();
  const ui = engine.useSync.getState();
  const writes = nativeWrites;
  release({ files: [], pending: [], damaged: [], present: [] });
  await cycle;
  assert.equal(second.getState(), state);
  assert.equal(engine.useSync.getState(), ui);
  assert.equal(nativeWrites, writes);
  disposeFirst();
  second.getState().updateSettings({ searchEngine: "google" });
  assert.ok(timers.size > 0, "the replacement owner's subscription is still running");
  disposeSecond();
  assert.equal(timers.size, 0);
  readListing = async () => ({ files: [], pending: [], damaged: [], present: [] });
});

test("window sync actions dispatch to the owner and wait for folder acceptance", async () => {
  const calls = [];
  let releaseFolder;
  const remove = installServiceClient(async (action, args) => {
    calls.push([action, args]);
    if (action === "setSyncFolder")
      await new Promise((resolve) => {
        releaseFolder = resolve;
      });
    if (action === "turnOnSync") return { ok: true };
    if (action === "enterRecoveryPhrase") return { ok: true };
    if (action === "addRemoteProfile") return "space-created";
    return null;
  });
  try {
    const state = engine.useSync.getState();
    assert.deepEqual(await engine.turnOnSync("/remote"), { ok: true });
    assert.deepEqual(await engine.enterRecoveryPhrase("/remote", "private phrase"), { ok: true });
    assert.equal(await engine.addRemoteProfile("remote-profile"), "space-created");
    await engine.syncNow();
    await engine.setTypeSynced("history", false);
    await engine.setProfileSynced("space", false);
    await engine.stopSync({ deleteData: true });
    let finished = false;
    const choosing = engine.chooseSyncFolder().then((result) => {
      finished = true;
      return result;
    });
    await settle();
    assert.equal(finished, false);
    assert.deepEqual(calls.at(-1), ["setSyncFolder", ["/picked"]]);
    releaseFolder();
    assert.equal(await choosing, picked);
    assert.equal(engine.useSync.getState(), state, "window actions do not mutate local sync state");
    assert.deepEqual(
      calls.map(([action]) => action),
      ["turnOnSync", "enterRecoveryPhrase", "addRemoteProfile", "syncNow", "setTypeSynced", "setProfileSynced", "stopSync", "setSyncFolder"],
    );
  } finally {
    remove();
  }
});
