const { useBrowser } = await import("../store/browserStore.ts");

import { AuthorityStore } from "../effect/ports/store.ts";
// The engine's tab strips (lib/engineTabs.ts): the snapshot the transactions are applied to, the ones that arrive
// before it, and what the app sends while the engine's answer is missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

// The reconciliation's own state is read through the dev harness, so a test can see what the app believes.
globalThis.__DEV__ = true;

const { EngineTabsEngine, EngineTabsService } = await import("./engineTabs.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { listIds, tabListKey } = await import("../store/model.ts");

// The engine's tab strips: a fake that keeps the contract — commands run later than they're sent, transactions
// arrive later than they're made, and the snapshot answers when it is asked.
class FakeEngine {
  rev = 0;
  lastCommand = 0;
  strips = new Map();
  commands = [];
  listener = undefined;
  givenBack = 0;
  snapshotDelay = 0;
  snapshotFails = false;
  snapshotCalls = 0;

  listen(listener) {
    this.listener = listener;

    return {
      remove: () => {
        this.listener = undefined;
        this.givenBack++;
      },
    };
  }

  snapshot() {
    this.snapshotCalls++;

    if (this.snapshotFails) return Promise.reject(new Error("the engine is busy"));

    const answer = { rev: this.rev, cmd: null, strips: [...this.strips.keys()].map((id) => this.state(id)) };

    if (!this.snapshotDelay) return Promise.resolve(answer);

    return new Promise((resolve) => setTimeout(() => resolve(answer), this.snapshotDelay));
  }

  command(command) {
    const id = ++this.lastCommand;

    this.commands.push({ id, command });

    return id;
  }

  state(id) {
    const s = this.strips.get(id);

    return {
      strip: id,
      window: id,
      profile: "",
      tabs: s.tabs.map((t, index) => ({ key: t.key, browser: t.browser, index, active: t.browser === s.active, pinned: !!t.pinned, group: null })),
    };
  }

  strip(id, tabs, active) {
    this.strips.set(id, { tabs, active });
  }

  // A change the engine reports: what made it, and the strips it touched.
  emit(cmd, ...ids) {
    const tx = { rev: ++this.rev, cmd, strips: ids.map((id) => this.state(id)) };

    this.deliver(tx);

    return tx;
  }

  deliver(tx) {
    this.listener?.(tx);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// The reconciliation, reading the engine the app talks to.
const withEngine = async (engine, use) => {
  globalThis.nnTestTabStrip = engine;

  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(
    EngineTabsService.layer.pipe(Layer.provide(AuthorityStore.layer(useBrowser)), Layer.provide(EngineTabsEngine.layer), Layer.provide(diagnostics.layer)),
  );

  const service = await runtime.runPromise(EngineTabsService);

  try {
    await use({ diagnostics, runtime, service });
  } finally {
    await runtime.dispose();
  }
};

test("the transactions that arrive before the snapshot are applied to it", async () => {
  const engine = new FakeEngine();

  engine.snapshotDelay = 20;
  engine.strip(10, [{ key: "t1", browser: 1, pinned: false }], 1);

  await withEngine(engine, async ({ runtime, service }) => {
    const started = runtime.runPromise(service.start);

    // The engine talks before its answer is in: the transaction waits for the snapshot.
    engine.emit(null, 10);

    await started;
    await tick();

    assert.equal(engine.snapshotCalls, 1, "the state was read once");
    assert.equal(globalThis.nnChromeTabs.state().lastRev, engine.rev, "the transaction that came early was applied");
    assert.equal(globalThis.nnChromeTabs.strips().length, 1, "the strip is known");
  });
});

test("a stale or duplicate transaction changes nothing", async () => {
  const engine = new FakeEngine();

  engine.strip(11, [{ key: "t2", browser: 1, pinned: false }], 1);

  await withEngine(engine, async ({ runtime, service }) => {
    await runtime.runPromise(service.start);
    await tick();

    const tx = engine.emit(null, 11);
    const revision = globalThis.nnChromeTabs.state().lastRev;
    const strips = globalThis.nnChromeTabs.strips();

    // The same transaction again, and one from before it: neither is a change.
    engine.deliver(tx);
    engine.deliver({ ...tx, rev: tx.rev - 1 });

    assert.equal(globalThis.nnChromeTabs.state().lastRev, revision, "the revision did not move");
    assert.deepEqual(globalThis.nnChromeTabs.strips(), strips, "the strips did not change");
  });
});

test("a snapshot that cannot be read is reported once, and nothing goes out", async () => {
  const engine = new FakeEngine();

  engine.snapshotFails = true;
  engine.strip(12, [{ key: "t3", browser: 1, pinned: false }], 1);

  await withEngine(engine, async ({ diagnostics, runtime, service }) => {
    await runtime.runPromise(service.start);
    await tick();

    assert.equal(diagnostics.reports.length, 1, "the failure is reported once");
    assert.equal(diagnostics.reports[0].operation.name, "engineTabs.snapshot");
    assert.equal(engine.commands.length, 0, "nothing went out while the state was unknown");

    // The engine talks: the state is read again, and the transaction is applied to it.
    engine.snapshotFails = false;
    engine.emit(null, 12);
    await tick();

    assert.equal(engine.snapshotCalls, 2, "the state was read again");
    assert.equal(globalThis.nnChromeTabs.state().lastRev, engine.rev, "the state that was read is the current one");
    assert.equal(diagnostics.reports.length, 1, "the failure is still reported once");
  });
});

test("the engine's transactions are given back when the scope closes", async () => {
  const engine = new FakeEngine();

  await withEngine(engine, async ({ runtime, service }) => {
    await runtime.runPromise(service.start);

    assert.ok(engine.listener, "the engine's transactions are read");

    await runtime.dispose();

    assert.equal(engine.listener, undefined, "the listener is gone");
    assert.equal(engine.givenBack, 1, "it was given back once");
  });
});

test("a command the engine does not answer is not sent again", async () => {
  const engine = new FakeEngine();
  const { useBrowser } = await import("../store/browserStore.ts");

  useBrowser.getState().updateSettings({ newTabPosition: "bottom" });

  const w = useBrowser.getState().createWindow();
  const a = useBrowser.getState().newTab(w, { url: "https://a.com", background: true });
  const b = useBrowser.getState().newTab(w, { url: "https://b.com", background: true });

  // Chrome has the tabs in the other order: the app's plan differs from it.
  engine.strip(
    1,
    [
      { key: b, browser: 2, pinned: false },
      { key: a, browser: 1, pinned: false },
    ],
    2,
  );

  await withEngine(engine, async ({ runtime, service }) => {
    await runtime.runPromise(service.start);
    await tick();

    assert.equal(engine.commands.length, 1, "the app sent the order Chrome needs");
    assert.deepEqual(engine.commands[0].command.keys, [a, b], "the order is the app's");

    // The app changes again while the command is on its way: the strip still waits for its answer.
    useBrowser.getState().newTab(w, { url: "https://c.com", background: true });
    await tick();

    assert.equal(engine.commands.length, 1, "the command was not sent again");
    assert.equal(Object.keys(globalThis.nnChromeTabs.state().inflight).length, 1, "one command is on its way");

    // The app's own order is what the user set: the engine's answer cannot reorder it.
    const s = useBrowser.getState();
    const order = listIds(s, tabListKey(s, s.tabs[a]));

    assert.deepEqual(
      order.filter((id) => id === a || id === b),
      [a, b],
      "the app's order stands",
    );

    useBrowser.getState().closeWindow(w);
  });
});
