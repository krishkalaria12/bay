// Little Bay's lifetime (components/littleBay/service.ts): the sweep that puts idle windows away, and the shortcut
// that opens one from any app, against a fake Mac and a scheduler the test fires by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../../store/browserStore.ts");
const { fakeDiagnostics, fakeScheduler } = await import("../../effect/testing.ts");
const { useLittleBayAccess } = await import("./access.ts");
const { LittleBayEngine, LittleBayService } = await import("./service.ts");

const HOUR = 60 * 60_000;
const S = () => useBrowser.getState();

const withLittleBay = async (use) => {
  const lab = { windowListeners: [], appListeners: [], hotKeys: [], menuBar: [], gates: [] };
  const scheduler = fakeScheduler();

  const engine = Layer.succeed(LittleBayEngine)({
    onWindowEvent: (listener) =>
      Effect.sync(() => {
        lab.windowListeners.push(listener);

        return () => (lab.windowListeners = lab.windowListeners.filter((l) => l !== listener));
      }),
    onAppEvent: (listener) =>
      Effect.sync(() => {
        lab.appListeners.push(listener);

        return () => (lab.appListeners = lab.appListeners.filter((l) => l !== listener));
      }),
    setHotKey: (shortcut) =>
      Effect.promise(async () => {
        lab.hotKeys.push(shortcut?.keyCode ?? null);

        const gate = lab.gates.shift();

        if (gate) await gate.promise;

        return shortcut ? (shortcut.keyCode === 1 ? "taken" : "registered") : "off";
      }),
    setMenuBarItem: (on) => Effect.sync(() => void lab.menuBar.push(on)),
  });

  const runtime = ManagedRuntime.make(LittleBayService.layer.pipe(Layer.provide(Layer.mergeAll(engine, scheduler.layer, fakeDiagnostics().layer))));

  S().hydrate({});
  useLittleBayAccess.setState({ status: "off" });

  const start = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* LittleBayService;

        yield* service.start;
      }),
    );

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    await use({ lab, scheduler, start, settle });
  } finally {
    await runtime.dispose();
  }

  return lab;
};

test("an idle Little Bay is put away once, by the job on the shared grid", async () => {
  await withLittleBay(async ({ scheduler, start }) => {
    const main = S().windowOrder[0] ?? S().createWindow();
    const small = S().createWindow({ small: true, url: "https://example.com/a" });

    // The main window is in front: the Little Bay is left alone.
    S().setFocusedWindow(main);
    S().updateSettings({ littleBayPutAwayAfterHours: 6 });
    await start();

    assert.equal(scheduler.jobs.length, 1, "one job, on the grid");
    assert.equal(scheduler.jobs[0].needed(), true, "a Little Bay is worth sweeping for");

    const realNow = Date.now;

    try {
      Date.now = () => S().windows[small].createdAt + 7 * HOUR;
      await scheduler.fire();
      await scheduler.fire();
    } finally {
      Date.now = realNow;
    }

    assert.equal(S().windows[small], undefined, "the window is put away");
    assert.equal(S().closedTabs.filter((c) => c.small).length, 1, "its page is archived once");
    assert.equal(scheduler.jobs[0].needed(), false, "with no Little Bay, the grid has nothing to wake for");
  });
});

test("a Little Bay in front is in use, and leaving it starts its time", async () => {
  await withLittleBay(async ({ lab, scheduler, start }) => {
    const main = S().windowOrder[0] ?? S().createWindow();
    const small = S().createWindow({ small: true, url: "https://example.com/a" });

    S().updateSettings({ littleBayPutAwayAfterHours: 6 });
    await start();

    lab.windowListeners[0]({ type: "focus", id: small });
    S().setFocusedWindow(small);

    const realNow = Date.now;

    try {
      Date.now = () => S().windows[small].createdAt + 100 * HOUR;
      await scheduler.fire();
      assert.ok(S().windows[small], "the window in front stays");

      // Bay goes to the background: the window is left alone from then.
      lab.appListeners[0]({ type: "resignActive" });
      await scheduler.fire();
      assert.ok(S().windows[small], "its time starts when it was left");
    } finally {
      Date.now = realNow;
    }

    assert.ok(S().windows[main]);
  });
});

test("the shortcut registers one choice at a time, and an older answer never shows over a newer one", async () => {
  await withLittleBay(async ({ lab, start, settle }) => {
    const first = Promise.withResolvers();

    lab.gates.push(first);
    S().updateSettings({ littleBayShortcut: { key: "a", keyCode: 1, modifiers: ["command"] } });
    await start();
    await settle();

    // A second choice while the first is on its way.
    S().updateSettings({ littleBayShortcut: { key: "b", keyCode: 2, modifiers: ["command"] } });
    await settle();
    assert.deepEqual(lab.hotKeys, [1], "the second waits for the first");

    first.resolve();
    await settle();
    await settle();

    assert.deepEqual(lab.hotKeys, [1, 2]);
    assert.equal(useLittleBayAccess.getState().status, "registered", "the newer choice's answer is the one shown");
  });
});

test("the listeners are given back when the runtime closes", async () => {
  const lab = await withLittleBay(async ({ lab, start }) => {
    await start();
    await start();

    assert.equal(lab.windowListeners.length, 1, "registered once");
    assert.equal(lab.appListeners.length, 1);
  });

  assert.equal(lab.windowListeners.length, 0);
  assert.equal(lab.appListeners.length, 0);
});
