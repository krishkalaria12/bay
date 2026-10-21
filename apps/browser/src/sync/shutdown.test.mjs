import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Each module instance has its own engine state. Native methods delegate through
// one stable object because @bay/sync binds the native module once per renderer.
globalThis.__DEV__ = false;
let controls;
const methods = [
  "newDeviceId",
  "deviceName",
  "createPhrase",
  "createChain",
  "unlock",
  "forget",
  "chainStatus",
  "write",
  "read",
  "remove",
  "sealLocal",
  "openLocal",
  "readPasswords",
  "enterPhrase",
  "deleteChain",
];
const native = Object.fromEntries(
  methods.map((name) => [
    name,
    (...args) => {
      controls.calls[name].push(args);
      return controls.behavior[name](...args);
    },
  ]),
);
globalThis.nnTestNativeModules = { BaySync: native };
const shell = await import("@bay/shell");
const { emptyScope } = await import("@bay/sync");
const { useBrowser } = await import("../store/browser.ts");
const tick = () => new Promise(setImmediate);
let instance = 0;
const types = () => ({ bookmarks: true, history: true, tabs: true, pinned: true, passwords: true, settings: true });
function defaults(folder) {
  return {
    newDeviceId: () => "dev-new",
    deviceName: () => "Test Desktop",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "unavailable",
    write: async (_folder, scope, payload) => {
      const id = `file-${folder.size}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const files = [...folder].filter(([, item]) => item.scope === scope);
      return {
        files: files.filter(([id]) => !known.includes(id)).map(([id, item]) => ({ id, payload: item.payload })),
        present: files.map(([id]) => id),
        pending: [],
        damaged: [],
      };
    },
    remove: async (_folder, _scope, ids) => ids.forEach((id) => folder.delete(id)),
    deleteChain: async () => {},
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (text) => (text.startsWith("sealed:") ? text.slice(7) : null),
    readPasswords: async () => null,
    enterPhrase: async () => ({ ok: true }),
  };
}
async function fixture(context, { enabled = true, scopes = { app: emptyScope() }, journal = {}, seqs = {}, overrides = {}, rawMetadata, start = true } = {}) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  shell.docs.clear();
  shell.heldSaves.on = false;
  shell.heldSaves.error = null;
  shell.heldSaves.queue.length = 0;
  useBrowser.getState().hydrate({});
  const folder = new Map(),
    releases = [];
  controls = { calls: Object.fromEntries(methods.map((name) => [name, []])), behavior: { ...defaults(folder), ...overrides } };
  const state = controls;
  shell.docs.set(
    "sync.json",
    rawMetadata ??
      JSON.stringify({
        v: 1,
        enabled,
        folder: "/sync",
        deviceId: enabled ? "dev-existing" : null,
        clock: null,
        types: types(),
        profiles: {},
        scopes: {},
        lastSyncedAt: null,
        setupAt: 1,
        joining: false,
        seqs,
      }),
  );
  shell.docs.set("sync-state.nns", `sealed:${JSON.stringify(scopes)}`);
  shell.docs.set("sync-journal.nns", `sealed:${JSON.stringify({ journal })}`);
  const engine = await import(`./engine.ts?shutdown-${++instance}`);
  context.after(async () => {
    state.behavior = defaults(folder);
    for (const release of releases) release();
    shell.heldSaves.on = false;
    shell.heldSaves.error = null;
    shell.heldSaves.queue.splice(0).forEach((land) => land());
    engine.resumeSyncAfterQuit();
    await engine.stopSync();
    await tick();
    context.mock.timers.reset();
  });
  if (start) engine.startSync(useBrowser);
  await tick();
  return {
    engine,
    state,
    folder,
    hold(name, fallback) {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      state.behavior[name] = () => promise;
      releases.push(() => resolve(fallback));
      return { resolve, reject };
    },
  };
}
async function landNext() {
  assert.ok(shell.heldSaves.queue.length);
  shell.heldSaves.queue.shift()();
  await tick();
}
const metadata = () => JSON.parse(shell.docs.get("sync.json"));

test("quit saves state, journal and metadata acknowledgements without another folder cycle", async (context) => {
  const { engine, state } = await fixture(context);
  shell.heldSaves.on = true;
  let done = false;
  const pending = engine.prepareSyncForQuit();
  void pending.then(() => {
    done = true;
  });
  assert.equal(engine.prepareSyncForQuit(), pending);
  await tick();
  assert.equal(shell.heldSaves.queue.length, 1);
  assert.equal(done, false);
  engine.setTypeSynced("bookmarks", false);
  engine.setSyncFolder("/other");
  engine.scheduleSync(0);
  await engine.syncNow();
  await engine.stopSync();
  assert.equal((await engine.enterRecoveryPhrase("/sync", "words")).error, "quitting");
  assert.ok("error" in (await engine.turnOnSync("/sync")));
  assert.equal(state.calls.enterPhrase.length, 0);
  assert.equal(state.calls.createPhrase.length, 0);
  await landNext();
  assert.equal(shell.heldSaves.queue.length, 1);
  assert.equal(done, false);
  await landNext();
  assert.equal(shell.heldSaves.queue.length, 1);
  assert.equal(done, false);
  await landNext();
  await pending;
  assert.equal(done, true);
  assert.equal(metadata().types.bookmarks, true);
  assert.equal(metadata().folder, "/sync");
  assert.equal(shell.docs.get("sync-journal.nns"), "");
  assert.equal(state.calls.chainStatus.length, 0);
  assert.equal(state.calls.forget.length, 0);
});

test("startup unlock and load finish before the final encrypted snapshot", async (context) => {
  let unlock, opened;
  const unlockPromise = new Promise((resolve) => {
    unlock = resolve;
  });
  const openPromise = new Promise((resolve) => {
    opened = resolve;
  });
  const scopes = { app: { ...emptyScope(), pending: 7 } };
  const { engine, state } = await fixture(context, {
    scopes,
    overrides: {
      unlock: () => unlockPromise,
      openLocal: (text) => (text.includes('"journal"') ? Promise.resolve(JSON.stringify({ journal: {} })) : openPromise),
    },
  });
  context.after(() => {
    unlock(true);
    opened(JSON.stringify(scopes));
  });
  let done = false;
  const pending = engine.prepareSyncForQuit();
  void pending.then(() => {
    done = true;
  });
  await tick();
  assert.equal(state.calls.sealLocal.length, 0);
  assert.equal(done, false);
  unlock(true);
  await tick();
  assert.equal(state.calls.openLocal.length, 1);
  assert.equal(done, false);
  opened(JSON.stringify(scopes));
  await pending;
  assert.equal(JSON.parse(shell.docs.get("sync-state.nns").slice(7)).app.pending, 7);
  assert.equal(state.calls.chainStatus.length, 0);
  assert.equal(state.calls.forget.length, 0);
});

test("locked sync retains ciphertext and metadata sequence counters", async (context) => {
  const { engine, state } = await fixture(context, { seqs: { app: 41 }, overrides: { unlock: async () => false } });
  const beforeState = shell.docs.get("sync-state.nns"),
    beforeJournal = shell.docs.get("sync-journal.nns");
  engine.setTypeSynced("history", false);
  await tick();
  assert.equal(shell.docs.get("sync-state.nns"), beforeState);
  await engine.prepareSyncForQuit();
  assert.equal(shell.docs.get("sync-state.nns"), beforeState);
  assert.equal(shell.docs.get("sync-journal.nns"), beforeJournal);
  assert.equal(metadata().seqs.app, 41);
  assert.equal(metadata().types.history, false);
  assert.equal(state.calls.sealLocal.length, 0);
  assert.equal(state.calls.forget.length, 0);
});

for (const rawMetadata of ["", "{broken", "null", "[]", "{}", '{"v":1,"enabled":true,"types":null}'])
  test(`invalid sync metadata is preserved and prevents final or background saves: ${rawMetadata}`, async (context) => {
    context.mock.method(console, "warn", () => {});
    const { engine, state } = await fixture(context, { rawMetadata });
    const before = new Map(shell.docs);
    engine.setTypeSynced("history", false);
    engine.setSyncFolder("/other");
    await engine.syncNow();
    await assert.rejects(engine.prepareSyncForQuit(), /saved sync metadata/);
    engine.resumeSyncAfterQuit();
    await tick();
    assert.deepEqual(shell.docs, before);
    assert.equal(state.calls.sealLocal.length, 0);
    assert.equal(state.calls.forget.length, 0);
    assert.equal(engine.useSync.getState().status, "locked");
  });

for (const [label, opened] of [
  ["null decrypt", null],
  ["invalid JSON", "{broken"],
  ["array root", "[]"],
  ["null root", "null"],
]) {
  for (const name of ["sync-state.nns", "sync-journal.nns"])
    test(`${name} preserves ciphertext after ${label}`, async (context) => {
      const { engine, state } = await fixture(context, {
        seqs: { app: 41 },
        overrides: {
          openLocal: async (text) => {
            const current = text.includes('"journal"') ? "sync-journal.nns" : "sync-state.nns";
            return current === name ? opened : text.slice(7);
          },
        },
      });
      const beforeState = shell.docs.get("sync-state.nns"),
        beforeJournal = shell.docs.get("sync-journal.nns");
      assert.equal(engine.useSync.getState().status, "locked");
      engine.setTypeSynced("history", false);
      await tick();
      await engine.prepareSyncForQuit();
      assert.equal(shell.docs.get("sync-state.nns"), beforeState);
      assert.equal(shell.docs.get("sync-journal.nns"), beforeJournal);
      assert.equal(metadata().seqs.app, 41);
      assert.equal(state.calls.sealLocal.length, 0);
      assert.equal(state.calls.forget.length, 0);
    });
}

test("preparing and cancelling quit before start does not write another owner's documents", async (context) => {
  const { engine } = await fixture(context, { start: false });
  const before = new Map(shell.docs);
  await engine.prepareSyncForQuit();
  engine.resumeSyncAfterQuit();
  await tick();
  assert.deepEqual(shell.docs, before);
});

test("recovery phrase entry reports unreadable saved data without replacing ciphertext", async (context) => {
  const { engine } = await fixture(context, { overrides: { unlock: async () => false, openLocal: async () => null } });
  const before = new Map(shell.docs);
  assert.deepEqual(await engine.enterRecoveryPhrase("/sync", "recovery words"), { error: "savedData" });
  assert.equal(engine.useSync.getState().status, "locked");
  await engine.prepareSyncForQuit();
  assert.equal(shell.docs.get("sync-state.nns"), before.get("sync-state.nns"));
  assert.equal(shell.docs.get("sync-journal.nns"), before.get("sync-journal.nns"));
});

test("cancelling quit without native sync support preserves existing sync documents", () => {
  // @bay/sync captures native availability once, so this scenario needs a fresh renderer.
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "./src/test-loader.mjs",
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    globalThis.__DEV__ = false;
    globalThis.nnTestNativeModules = {};
    const shell = await import("@bay/shell");
    shell.docs.set("sync.json", '{"v":1,"enabled":true}');
    shell.docs.set("sync-state.nns", "existing-ciphertext");
    shell.docs.set("sync-journal.nns", "existing-journal");
    const before = new Map(shell.docs);
    const engine = await import("./src/sync/engine.ts");
    engine.startSync((await import("./src/store/browser.ts")).useBrowser);
    await engine.prepareSyncForQuit();
    engine.resumeSyncAfterQuit();
    await new Promise(setImmediate);
    assert.deepEqual(shell.docs, before);
  `,
    ],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("syncNow joins active work and quit waits for that work without starting a cycle", async (context) => {
  const { engine, state, hold } = await fixture(context),
    chain = hold("chainStatus", "unavailable");
  const syncing = engine.syncNow();
  await tick();
  let joined = false;
  const joining = engine.syncNow().then(() => {
    joined = true;
  });
  const pending = engine.prepareSyncForQuit();
  await tick();
  assert.equal(joined, false);
  assert.equal(state.calls.chainStatus.length, 1);
  assert.equal(state.calls.sealLocal.length, 0);
  chain.resolve("unavailable");
  await Promise.all([syncing, joining, pending]);
  assert.equal(joined, true);
  assert.equal(state.calls.chainStatus.length, 1);
});

test("a failed active cycle rejects quit rather than checkpointing unfinished work", async (context) => {
  context.mock.method(console, "warn", () => {});
  const { engine, state, hold } = await fixture(context),
    chain = hold("chainStatus", "unavailable");
  const syncing = engine.syncNow();
  await tick();
  const pending = engine.prepareSyncForQuit();
  const refused = assert.rejects(pending, /cloud failed/);
  chain.reject(new Error("cloud failed"));
  await syncing;
  await refused;
  assert.equal(state.calls.sealLocal.length, 0);
});

test("stuck I/O rejects below the native deadline and late completion cannot save", async (context) => {
  const { engine, state, hold } = await fixture(context),
    chain = hold("chainStatus", "unavailable");
  const syncing = engine.syncNow();
  await tick();
  const pending = engine.prepareSyncForQuit();
  let rejected = false;
  const refused = assert.rejects(pending, { code: "sync_quit_timeout" }).then(() => {
    rejected = true;
  });
  context.mock.timers.tick(14999);
  await tick();
  assert.equal(rejected, false);
  context.mock.timers.tick(1);
  await refused;
  chain.resolve("unavailable");
  await syncing;
  await tick();
  assert.equal(state.calls.sealLocal.length, 0);
});

test("cancelled seals cannot overwrite a newer quit attempt", async (context) => {
  const { engine, state, hold } = await fixture(context),
    seal = hold("sealLocal", "stale-ciphertext");
  const cancelled = engine.prepareSyncForQuit();
  await tick();
  const refused = assert.rejects(cancelled, { code: "sync_quit_cancelled" });
  engine.resumeSyncAfterQuit();
  await refused;
  state.behavior.sealLocal = async (text) => `sealed:${text}`;
  engine.setTypeSynced("bookmarks", false);
  const current = engine.prepareSyncForQuit();
  seal.resolve("stale-ciphertext");
  await current;
  const saved = new Map(shell.docs);
  await tick();
  assert.equal(metadata().types.bookmarks, false);
  assert.notEqual(shell.docs.get("sync-state.nns"), "stale-ciphertext");
  assert.deepEqual(shell.docs, saved);
});

test("cancelled saves cannot enqueue their later journal or metadata writes", async (context) => {
  const { engine } = await fixture(context);
  shell.heldSaves.on = true;
  const cancelled = engine.prepareSyncForQuit();
  await tick();
  assert.equal(shell.heldSaves.queue.length, 1);
  const refused = assert.rejects(cancelled, { code: "sync_quit_cancelled" });
  engine.resumeSyncAfterQuit();
  await refused;
  engine.setTypeSynced("history", false);
  await tick();
  assert.equal(shell.heldSaves.queue.length, 2, "one old final save and one resumed state save");
  await landNext();
  assert.equal(shell.heldSaves.queue.length, 1, "the cancelled final save cannot enqueue journal clearing");
  assert.equal(metadata().types.history, false);
  shell.heldSaves.on = false;
  await landNext();
});

for (const stage of [0, 1, 2])
  test(`final document save ${stage + 1} failure rejects quit and remains retryable`, async (context) => {
    const { engine, state } = await fixture(context);
    shell.heldSaves.on = true;
    const pending = engine.prepareSyncForQuit();
    await tick();
    for (let index = 0; index < stage; index++) await landNext();
    const refused = assert.rejects(pending, /disk full/);
    shell.heldSaves.error = new Error("disk full");
    await landNext();
    await refused;
    assert.equal(state.calls.forget.length, 0);
    shell.heldSaves.error = null;
    shell.heldSaves.on = false;
    engine.resumeSyncAfterQuit();
    await engine.prepareSyncForQuit();
    assert.equal(metadata().enabled, true);
  });

test("sealing failures stop retrying and the explicit final failure propagates", async (context) => {
  context.mock.method(console, "warn", () => {});
  const { engine, state } = await fixture(context);
  state.behavior.sealLocal = async () => {
    throw new Error("seal failed");
  };
  engine.setTypeSynced("history", false);
  await tick();
  await tick();
  assert.equal(state.calls.sealLocal.length, 1);
  await assert.rejects(engine.prepareSyncForQuit(), /seal failed/);
  await tick();
  assert.equal(state.calls.sealLocal.length, 2);
  state.behavior.sealLocal = async (text) => `sealed:${text}`;
  engine.resumeSyncAfterQuit();
  await engine.prepareSyncForQuit();
});

test("checkpoint waits for setup already underway without forgetting the new key", async (context) => {
  const { engine, state, hold } = await fixture(context, { enabled: false }),
    creation = hold("createChain", undefined);
  const turningOn = engine.turnOnSync("/new-sync");
  await tick();
  const pending = engine.prepareSyncForQuit();
  await tick();
  assert.equal(state.calls.sealLocal.length, 0);
  creation.resolve();
  assert.deepEqual(await turningOn, { ok: true });
  await pending;
  assert.equal(metadata().enabled, true);
  assert.equal(metadata().folder, "/new-sync");
  assert.equal(metadata().deviceId, "dev-new");
  assert.equal(state.calls.forget.length, 0);
  assert.equal(state.calls.chainStatus.length, 0);
});

test("saved state covers replayable journal batches before the external journal clears", async (context) => {
  const batch = { v: 1, kind: "log", device: "dev-existing", seq: 1, at: 1, ops: [] };
  const { engine } = await fixture(context, { scopes: { app: emptyScope() }, journal: { app: [batch] } });
  await engine.prepareSyncForQuit();
  const scopes = JSON.parse(shell.docs.get("sync-state.nns").slice(7));
  assert.equal(scopes.app.seq, 1);
  assert.deepEqual(scopes.app.journal, [batch]);
  assert.equal(metadata().seqs.app, 0);
  assert.equal(shell.docs.get("sync-journal.nns"), "");
});

test("explicit stopSync still retires and forgets the device", async (context) => {
  const { engine, state } = await fixture(context);
  state.behavior.chainStatus = async () => "ok";
  await engine.syncNow();
  const published = state.calls.write.length;
  assert.ok(published > 0, "the device is published before retiring");
  await engine.stopSync();
  assert.equal(state.calls.forget.length, 1);
  assert.equal(state.calls.forget[0][0], "dev-existing");
  assert.equal(metadata().enabled, false);
  assert.equal(shell.docs.get("sync-state.nns"), "");
  assert.equal(shell.docs.get("sync-journal.nns"), "");
  const retired = state.calls.write.slice(published).flatMap(([, , payload]) => JSON.parse(payload).ops ?? []);
  assert.ok(
    retired.some((op) => op.k === "dev:dev-existing" && op.v === null),
    "explicit stop still publishes its retirement",
  );
});

test("stopping a new sync setup clears a state save whose acknowledgement is still pending", async (context) => {
  const { engine } = await fixture(context, { enabled: false });
  engine.setSyncFolder("/new-sync");
  assert.equal(shell.docs.get("sync-state.nns"), "");
  shell.heldSaves.on = true;
  assert.deepEqual(await engine.turnOnSync("/new-sync"), { ok: true });
  await tick();
  assert.equal(shell.heldSaves.queue.length, 1);
  const writes = context.mock.method(shell.docs, "set");
  await engine.stopSync();
  // The native document writer orders this clear after the pending state save.
  // The shell test stub does not model that native queue, so verify it is sent.
  assert.ok(writes.mock.calls.some(({ arguments: args }) => args[0] === "sync-state.nns" && args[1] === ""));
  shell.heldSaves.on = false;
  await landNext();
  assert.equal(metadata().enabled, false);
});
