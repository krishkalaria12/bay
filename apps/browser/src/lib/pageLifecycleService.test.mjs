// The pages' lifetime (lib/pageLifecycleService.ts): the Mac's events, the sweep on the shared grid and the waits
// before the recent tabs reopen, against a fake Mac, a scheduler the test fires by hand, and the test clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../store/browserStore.ts");
const { fakeDiagnostics, fakeScheduler } = await import("../effect/testing.ts");
const { LifecycleEngine, PageLifecycleService } = await import("./pageLifecycleService.ts");

const S = () => useBrowser.getState();

const NORMAL = { memoryPressure: "normal", physicalMemory: 32 * 2 ** 30, onBattery: false, lowPowerMode: false };

const withLifecycle = async (use) => {
  const lab = { sweeps: 0, systemListeners: [], windowListeners: [], appListeners: [] };
  const scheduler = fakeScheduler();

  const listen = (list) => (listener) =>
    Effect.sync(() => {
      lab[list].push(listener);

      return () => (lab[list] = lab[list].filter((l) => l !== listener));
    });

  const engine = Layer.succeed(LifecycleEngine)({
    onWindowEvent: listen("windowListeners"),
    onAppEvent: listen("appListeners"),
    systemState: () => Effect.succeed(NORMAL),
    onSystemState: listen("systemListeners"),
    sweep: () => Effect.sync(() => (lab.sweeps++, [])),
  });

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(PageLifecycleService.layer.pipe(Layer.provide(Layer.mergeAll(engine, scheduler.layer, fakeDiagnostics().layer))), TestClock.layer()),
  );

  const start = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* PageLifecycleService;

        yield* service.start;
      }),
    );

  const advance = (ms) => runtime.runPromise(TestClock.adjust(ms));

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    await use({ lab, scheduler, start, advance, settle });
  } finally {
    await runtime.dispose();
  }

  return lab;
};

// A recent tab in the background, with no page yet: one of the tabs reopened at launch.
function recentTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://shown.example" });
  const id = S().newTab(w, { url: "https://recent.example", background: true });

  S().updateTab(id, { navigation: null, lastActiveAt: Date.now() });

  return id;
}

test("the sweep is one job on the grid, and memory pressure that rises sweeps at once", async () => {
  await withLifecycle(async ({ lab, scheduler, start, settle }) => {
    recentTab();
    await start();
    await start();
    await settle();

    assert.equal(scheduler.jobs.length, 1, "registered once");
    await scheduler.fire();
    assert.equal(lab.sweeps, 1);

    lab.systemListeners[0]({ ...NORMAL, memoryPressure: "warning" });
    await settle();
    assert.equal(lab.sweeps, 2, "pressure that rose sweeps");

    lab.systemListeners[0]({ ...NORMAL, memoryPressure: "warning" });
    await settle();
    assert.equal(lab.sweeps, 2, "pressure that stays does not sweep again");
  });
});

test("the recent tabs reopen after their waits", async () => {
  await withLifecycle(async ({ start, advance, settle }) => {
    const id = recentTab();

    await start();
    await settle();
    await advance(3000);
    assert.equal(S().tabs[id].navigation, null, "not before its turn");

    await advance(2000);
    assert.ok(S().tabs[id].navigation, "reopened");
  });
});

test("a wait the scope ends reopens nothing, and the listeners are given back", async () => {
  let id;

  const lab = await withLifecycle(async ({ start, advance, settle }) => {
    id = recentTab();

    await start();
    await settle();
    await advance(1000);
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(S().tabs[id].navigation, null, "the closed scope's wait did nothing");
  assert.equal(lab.systemListeners.length, 0);
  assert.equal(lab.windowListeners.length, 0);
  assert.equal(lab.appListeners.length, 0);
});
