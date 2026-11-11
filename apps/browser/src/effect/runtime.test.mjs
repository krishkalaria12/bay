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
const { appLayer, desktopReady, desktopRuntime, startAppServices } = await import("./runtime.ts");
const { Persistence } = await import("../lib/persistenceService.ts");
const { History } = await import("../lib/historyService.ts");
const { Bookmarks } = await import("../lib/bookmarkService.ts");
const { ProfileCleanup } = await import("../lib/profileCleanup.ts");
const { LibraryService } = await import("../components/library/libraryService.ts");
const { UpdaterService } = await import("../lib/updaterService.ts");
const { UsageService } = await import("../telemetry/usageService.ts");
const { LittleBayService } = await import("../components/littleBay/service.ts");
const { PageLifecycleService } = await import("../lib/pageLifecycleService.ts");
const { slowTimersForTests } = await import("../lib/throttledTimers.ts");

const B = 1_000_000_020_000;
const lab = slowTimersForTests(() => B);

test("the app's services are there, and the runtime is built once", async () => {
  await desktopReady;

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

test("pending or failed history startup leaves unrelated services free to start", async (t) => {
  const tags = [Persistence, History, Bookmarks, ProfileCleanup, LibraryService, UpdaterService, UsageService, LittleBayService, PageLifecycleService];
  const services = await desktopRuntime.runPromise(Effect.all(tags));
  const original = services.map((service) => service.start);
  const calls = [];
  const history = Promise.withResolvers();
  const reported = t.mock.method(console, "error", () => {});

  for (let i = 0; i < services.length; i++) services[i].start = Effect.sync(() => void calls.push(i));

  services[1].start = services[1].start.pipe(Effect.andThen(Effect.promise(() => history.promise)));
  services[2].start = services[2].start.pipe(Effect.andThen(Effect.fail(new Error("bookmark read failed"))));

  const starting = startAppServices();

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls[0], 0, "persistence registers before background services");
    assert.deepEqual(
      [...calls].sort((a, b) => a - b),
      tags.map((_, i) => i),
      "all services start while history is pending",
    );
  } finally {
    history.resolve();
    await starting;

    for (let i = 0; i < services.length; i++) services[i].start = original[i];
  }

  assert.equal(reported.mock.callCount(), 1, "a failed service is reported once");
});
