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
const { appLayer, desktopReady, desktopRuntime } = await import("./runtime.ts");
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
