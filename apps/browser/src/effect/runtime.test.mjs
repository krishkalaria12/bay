// The app's runtime (effect/runtime.ts): one per JavaScript instance, shared by every window, and giving everything
// it owns back when it is disposed.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { Diagnostics } = await import("./ports/diagnostics.ts");
const { Documents } = await import("./ports/documents.ts");
const { Http } = await import("./ports/http.ts");
const { Scheduler } = await import("./ports/scheduler.ts");
const { desktopReady, desktopRuntime, runtimeForStore } = await import("./runtime.ts");
const { appLayer: servicesLayer } = await import("./runtimeLayer.ts");
const { AuthorityStore } = await import("./ports/store.ts");
const { ReadBrowser } = await import("./windowPorts.ts");
const { createBrowserStore, useBrowser } = await import("../store/browserStore.ts");
const appLayer = servicesLayer.pipe(Layer.provideMerge(Layer.mergeAll(AuthorityStore.layer(useBrowser), ReadBrowser.layer(useBrowser))));
const { History } = await import("../lib/historyService.ts");
const { Bookmarks } = await import("../lib/bookmarkService.ts");
const { ProfileCleanup } = await import("../lib/profileCleanup.ts");
const { LibraryService } = await import("../components/library/libraryService.ts");
const { UpdaterService } = await import("../lib/updaterService.ts");
const { UsageService } = await import("../telemetry/usageService.ts");
const { LittleBayService } = await import("../components/littleBay/service.ts");
const { PageLifecycleService } = await import("../lib/pageLifecycleService.ts");
const { slowTimersForTests } = await import("../lib/throttledTimers.ts");
const { startCoordinatorServices } = await import("../runtime/services.ts");

const B = 1_000_000_020_000;
const lab = slowTimersForTests(() => B);

test("the app's services are there, and the runtime is built once", async () => {
  await desktopReady();

  const services = await desktopRuntime.runPromise(
    Effect.gen(function* () {
      return {
        diagnostics: yield* Diagnostics,
        documents: yield* Documents,
        http: yield* Http,
        scheduler: yield* Scheduler,
      };
    }),
  );

  assert.ok(services.diagnostics);
  assert.ok(services.documents);
  assert.ok(services.http);
  assert.ok(services.scheduler);

  // The same services answer every run: two windows are two callers of one runtime.
  const first = await desktopRuntime.context();
  const second = await desktopRuntime.context();

  assert.equal(first, second);
});

test("a runtime that is disposed gives back everything it was holding", async () => {
  lab.clear();

  const runtime = ManagedRuntime.make(appLayer, { memoMap: Layer.makeMemoMapUnsafe() });

  await runtime.runPromise(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;

      yield* scheduler.every({ every: 30_000, run: Effect.void });
    }),
  );

  assert.notEqual(lab.pending(), null);
  await runtime.dispose();
  assert.equal(lab.pending(), null);
});

test("pending or failed history startup leaves the coordinator's other services free to start", async (t) => {
  const store = createBrowserStore();
  const tags = [History, Bookmarks, ProfileCleanup, LibraryService, UpdaterService, UsageService, LittleBayService, PageLifecycleService];
  // The coordinator's services are its store's runtime's: the same instances it starts.
  const services = await runtimeForStore(store).runPromise(Effect.all(tags));
  const calls = [];
  const history = Promise.withResolvers();
  const reported = t.mock.method(console, "error", () => {});

  for (let i = 0; i < services.length; i++) services[i].start = Effect.sync(() => void calls.push(i));

  services[0].start = services[0].start.pipe(Effect.andThen(Effect.promise(() => history.promise)));
  services[1].start = services[1].start.pipe(Effect.andThen(Effect.fail(new Error("bookmark read failed"))));

  const owner = startCoordinatorServices({ store, pageLifecycle: true });

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      [...calls].sort((a, b) => a - b),
      tags.map((_, i) => i),
      "all services start while history is pending",
    );
  } finally {
    history.resolve();
    await owner.ready;
    owner.dispose();
    await owner.settled;
  }

  assert.equal(reported.mock.callCount(), 1, "a failed service is reported once");
});
