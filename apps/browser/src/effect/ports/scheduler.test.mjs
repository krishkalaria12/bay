// The scheduler port (effect/ports/scheduler.ts): a job on the shared grid, the work it does, and the scope that
// lets it go. The grid's own algorithm is covered by lib/throttledTimers.test.mjs; this is the door into it.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { Scheduler } = await import("./scheduler.ts");
const { fakeDiagnostics } = await import("../testing.ts");
const { slowTimersForTests } = await import("../../lib/throttledTimers.ts");

const B = 1_000_000_020_000;
let now = B;
const lab = slowTimersForTests(() => now);

const at = (t) => {
  now = t;
  lab.fire();
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const withScheduler = async (use) => {
  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(Layer.mergeAll(diagnostics.layer, Scheduler.layer).pipe(Layer.provide(diagnostics.layer)));

  try {
    return await use(runtime, diagnostics);
  } finally {
    await runtime.dispose();
  }
};

test("a job runs when its slot comes round, and not before", async () => {
  lab.clear();
  now = B;
  const ran = [];

  await withScheduler(async (runtime) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;

        yield* scheduler.every({ every: 30_000, run: Effect.sync(() => void ran.push("job")) });
      }),
    );

    assert.deepEqual(ran, []);
    at(B + 10_000);
    await settle();
    assert.deepEqual(ran, []);
    at(B + 30_000);
    await settle();
    assert.deepEqual(ran, ["job"]);
  });
});

test("a job that fails is reported once, and the grid keeps it", async () => {
  lab.clear();
  now = B;
  let runs = 0;

  await withScheduler(async (runtime, diagnostics) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;

        yield* scheduler.every({
          every: 30_000,
          run: Effect.suspend(() => {
            runs += 1;

            return Effect.fail(new Error("boom"));
          }),
        });
      }),
    );

    at(B + 30_000);
    await settle();
    assert.equal(runs, 1);
    assert.equal(diagnostics.reports.length, 1);
    assert.equal(diagnostics.reports[0].message, "boom");

    // The next slot runs it again: a failed job does not take the grid down with it.
    at(B + 60_000);
    await settle();
    assert.equal(runs, 2);
    assert.equal(diagnostics.reports.length, 2);
  });
});

test("closing the scope gives the job back, and the grid goes idle", async () => {
  lab.clear();
  now = B;

  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(Layer.mergeAll(diagnostics.layer, Scheduler.layer).pipe(Layer.provide(diagnostics.layer)));

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
