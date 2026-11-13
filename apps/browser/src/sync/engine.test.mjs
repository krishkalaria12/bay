// 0.2.11: a crash at the wrong moment could stop some changes from reaching your other Macs.
import assert from "node:assert/strict";
import { test } from "node:test";

// Cycles run only when the test calls syncNow.
globalThis.setTimeout = () => 0;

globalThis.clearTimeout = () => {};

globalThis.__DEV__ = false;

const folder = new Map();
let onWrite = null;
let ids = 0;

globalThis.nnTestNativeModules = {
  BaySync: {
    newDeviceId: () => `dev${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    deleteChain: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      onWrite?.(JSON.parse(payload));

      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const files = here.flatMap(([id, f]) => (known.includes(id) ? [] : [{ id, payload: f.payload }]));

      return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("@bay/desktop");
const { useBrowser } = await import("../store/browserStore.ts");
const S = () => useBrowser.getState();

// Bookmarks are the store's alone here (lib/bookmarks.ts, which reads Chrome's, isn't running).
const reset = () => (S().hydrate({}), useBrowser.setState({ bookmarksReady: { default: true } }));

test("a crash after a batch lands: after the restart it's sent again as it was, and the next batch gets a new seq", async () => {
  reset();
  const first = await import("./engine.ts?first");
  first.startSync(useBrowser);
  assert.ok("ok" in (await first.turnOnSync("/sync")));
  S().addBookmark({ spaceId: "default", url: "https://one.example/", title: "One" });
  await first.syncNow();

  // The app quits the moment the batch with "Two" is in the folder: the disk stays as it is then.
  let disk = null;
  onWrite = (file) => {
    if (!disk && file.ops?.some((op) => op.v?.t === "Two")) disk = new Map(shell.docs);
  };

  S().addBookmark({ spaceId: "default", url: "https://two.example/", title: "Two" });
  await first.syncNow();
  onWrite = null;
  assert.ok(disk);
  shell.docs.clear();

  for (const [name, contents] of disk) shell.docs.set(name, contents);

  const second = await import("./engine.ts?second");
  second.startSync(useBrowser);

  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  S().addBookmark({ spaceId: "default", url: "https://three.example/", title: "Three" });
  await second.syncNow();

  const batches = new Map();

  for (const { scope, payload } of folder.values()) {
    const file = JSON.parse(payload);

    if (file.kind !== "log") continue;
    const key = `${scope} ${file.device} ${file.seq}`;
    assert.equal(batches.get(key) ?? payload, payload, `${key} was published twice with different changes`);
    batches.set(key, payload);
  }

  const three = [...folder.values()].map((f) => JSON.parse(f.payload)).find((f) => f.ops?.some((op) => op.v?.t === "Three"));
  assert.deepEqual(
    three.ops.map((op) => op.v?.t),
    ["Three"],
    "only what's new",
  );
  assert.equal(shell.docs.get("sync-journal.nns"), "", "the journal is emptied once the saved state has its batches");
});

test("a batch is published only once the journal holding it is on disk", async () => {
  reset();
  const engine = await import("./engine.ts?held");
  engine.startSync(useBrowser);
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();

  const published = () =>
    [...folder.values()].flatMap((f) => {
      const parsed = JSON.parse(f.payload);

      return parsed.ops?.some((op) => op.v?.t === "Held") ? [parsed] : [];
    });

  shell.heldSaves.on = true;
  S().addBookmark({ spaceId: "default", url: "https://held.example/", title: "Held" });
  const syncing = engine.syncNow();

  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published().length, 0, "nothing goes out while the journal save is still pending");
  assert.ok(shell.heldSaves.queue.length > 0, "the journal save is waiting");

  shell.heldSaves.on = false;

  for (const land of shell.heldSaves.queue.splice(0)) land();
  await syncing;
  assert.equal(published().length, 1, "published once the journal landed");
});

const flushWork = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("syncNow called during a native cycle awaits the coalesced next cycle", async () => {
  reset();
  shell.docs.clear();
  const engine = await import("./engine.ts?coalesced");
  engine.startSync(useBrowser);
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();

  const native = globalThis.nnTestNativeModules.BaySync;
  const original = native.chainStatus;
  const firstGate = Promise.withResolvers();
  const nextGate = Promise.withResolvers();
  let cycles = 0;

  native.chainStatus = async () => {
    cycles++;
    await (cycles === 1 ? firstGate.promise : nextGate.promise);

    return "ok";
  };

  try {
    const first = engine.syncNow();

    await flushWork();
    assert.equal(cycles, 1);

    let completed = false;
    const pending = Promise.all([engine.syncNow(), engine.syncNow()]).then(() => (completed = true));

    await flushWork();
    firstGate.resolve();
    await first;
    await flushWork();
    assert.equal(cycles, 2);
    assert.equal(completed, false, "the first cycle did not satisfy the later requests");
    nextGate.resolve();
    await pending;
    assert.equal(cycles, 2, "the burst requested only one rerun");
  } finally {
    firstGate.resolve();
    nextGate.resolve();
    native.chainStatus = original;
  }
});

test("stop waits for held disk writes before retiring and forgetting credentials", async () => {
  reset();
  shell.docs.clear();
  const engine = await import("./engine.ts?stop-settlement");
  const { SyncStopped } = await import("./service.ts");
  engine.startSync(useBrowser);
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();

  const native = globalThis.nnTestNativeModules.BaySync;
  const original = native.forget;
  let forgotten = false;

  native.forget = async () => (forgotten = true);
  shell.heldSaves.on = true;

  try {
    S().addBookmark({ spaceId: "default", url: "https://stop.example/", title: "Stop" });
    const syncing = engine.syncNow();
    const cancelled = assert.rejects(syncing, (error) => error instanceof SyncStopped);

    await flushWork();
    assert.ok(shell.heldSaves.queue.length > 0);

    const stopping = engine.stopSync();

    await cancelled;
    await flushWork();
    assert.equal(forgotten, false, "the disk write still owns the native operation");
    await assert.rejects(engine.syncNow(), (error) => error instanceof SyncStopped);
    engine.scheduleSync(0);
    shell.heldSaves.on = false;

    for (const land of shell.heldSaves.queue.splice(0)) land();
    await stopping;
    assert.equal(forgotten, true);
    assert.equal(engine.useSync.getState().status, "off");
    assert.equal(shell.docs.get("sync-journal.nns"), "");
    assert.equal(shell.docs.get("sync-state.nns"), "");
    await flushWork();
    assert.equal(shell.docs.get("sync-state.nns"), "", "no late sealed write restores the stopped session");
  } finally {
    native.forget = original;
    shell.heldSaves.on = false;

    for (const land of shell.heldSaves.queue.splice(0)) land();
  }
});

test("stopping a locked launch clears old sealed state without attempting retirement", async () => {
  reset();
  shell.docs.clear();
  shell.docs.set("sync.json", JSON.stringify({ v: 1, enabled: true, folder: "/sync", deviceId: "locked-device" }));
  shell.docs.set("sync-state.nns", "sealed:previous state");
  shell.docs.set("sync-journal.nns", "sealed:previous journal");
  const native = globalThis.nnTestNativeModules.BaySync;
  const unlock = native.unlock;
  const status = native.chainStatus;
  let cycles = 0;

  native.unlock = async () => false;
  native.chainStatus = async () => {
    cycles++;

    return "ok";
  };

  try {
    const engine = await import("./engine.ts?locked-stop");
    engine.startSync(useBrowser);
    await flushWork();
    assert.equal(engine.useSync.getState().status, "locked");
    await engine.stopSync();
    assert.equal(cycles, 0);
    assert.equal(shell.docs.get("sync-state.nns"), "");
    assert.equal(shell.docs.get("sync-journal.nns"), "");
    assert.equal(engine.useSync.getState().status, "off");
  } finally {
    native.unlock = unlock;
    native.chainStatus = status;
  }
});
