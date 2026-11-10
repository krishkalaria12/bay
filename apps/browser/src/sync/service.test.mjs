import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { fakeDiagnostics } = await import("../effect/testing.ts");
const { Sync, SyncFailure, SyncStopped } = await import("./service.ts");

const withWorker = async (use, initialize = Effect.void) => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(Layer.mergeAll(Sync.layer.pipe(Layer.provide(diagnostics.layer)), TestClock.layer()));
  const calls = [];
  const gates = [];

  const lab = {
    enabled: true,
    retire: true,
    fail: false,
    defect: false,
    starts: 0,
    stops: 0,
    listeners: 0,
    updates: 0,
    active: 0,
    maxActive: 0,
  };

  const worker = await runtime.runPromise(
    Effect.gen(function* () {
      const sync = yield* Sync;

      return yield* sync.open({
        enabled: () => lab.enabled,
        initialize: Effect.andThen(
          Effect.sync(() => calls.push("initialize")),
          initialize,
        ),
        retire: () => lab.retire,
        updating: () => lab.updates++,
        cycle: (retiring, forced) =>
          Effect.suspend(() => {
            lab.starts++;
            lab.active++;
            lab.maxActive = Math.max(lab.maxActive, lab.active);
            calls.push({ retiring, forced });

            const gate = gates.shift();
            const work = gate ? Effect.promise(() => gate.promise) : Effect.void;

            return work.pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (lab.defect) return Effect.die(new Error("defect containing private content"));

                  if (lab.fail) return Effect.fail(new SyncFailure({ operation: "cycle", cause: new Error("native failure") }));

                  return Effect.void;
                }),
              ),
              Effect.ensuring(Effect.sync(() => lab.active--)),
            );
          }),
        stop: (deleteData) =>
          Effect.sync(() => {
            calls.push({ stop: deleteData });
            lab.stops++;
            lab.enabled = false;
          }),
        subscribe: () => {
          lab.listeners++;

          return () => lab.listeners--;
        },
      });
    }),
  );

  const held = [];

  const hold = () => {
    const gate = Promise.withResolvers();

    gates.push(gate);
    held.push(gate);

    return gate.resolve;
  };

  const advance = (ms = 0) => runtime.runPromise(TestClock.adjust(ms));
  const now = () => runtime.runPromise(worker.now);

  try {
    await use({ lab, worker, calls, hold, advance, now, runtime, diagnostics });
  } finally {
    for (const gate of held) gate.resolve();
    await runtime.dispose();
    assert.equal(lab.listeners, 0);
    assert.equal(lab.active, 0);
  }
};

test("a burst of scheduled edits resets the debounce and produces one cycle", async () => {
  await withWorker(async ({ lab, worker, advance }) => {
    worker.schedule();
    await advance(2000);
    assert.equal(lab.starts, 0);
    worker.schedule();
    await advance(2999);
    assert.equal(lab.starts, 0);
    await advance(1);
    assert.equal(lab.starts, 1);
    await advance(14999);
    assert.equal(lab.starts, 1);
    await advance(1);
    assert.equal(lab.starts, 2, "normal periodic cycles retain the existing interval");
  });
});

test("syncNow bypasses a pending debounce and forces a password read", async () => {
  await withWorker(async ({ lab, worker, advance, now, calls }) => {
    worker.schedule();
    await advance(1000);
    await now();
    assert.equal(lab.starts, 1);
    assert.deepEqual(calls[1], { retiring: false, forced: true });
    await advance(3000);
    assert.equal(lab.starts, 1, "the old debounce cannot run another cycle");
  });
});

test("requests during a cycle wait for one coalesced rerun, not the current cycle", async () => {
  await withWorker(async ({ lab, advance, now, hold, worker }) => {
    const finishFirst = hold();
    const first = now();

    await advance();
    assert.equal(lab.starts, 1);

    const finishSecond = hold();
    const burst = Array.from({ length: 25 }, () => now());
    let resolved = false;

    void Promise.all(burst).then(() => (resolved = true));
    await advance();
    worker.schedule(3000);
    finishFirst();
    await first;
    await advance();
    assert.equal(lab.starts, 2);
    assert.equal(resolved, false);
    finishSecond();
    await Promise.all(burst);
    assert.equal(lab.maxActive, 1);
    assert.equal(lab.starts, 2);
  });
});

test("stopping rejects waiters immediately but keeps native exclusivity through settlement and retirement", async () => {
  await withWorker(async ({ lab, advance, now, hold, worker, runtime, calls }) => {
    const release = hold();
    const first = now();
    const rejectedFirst = assert.rejects(first, (error) => error instanceof SyncStopped);

    await advance();

    const second = now();
    const rejectedSecond = assert.rejects(second, (error) => error instanceof SyncStopped);
    const stopped = runtime.runPromise(worker.stop(true));

    await advance();
    await Promise.all([rejectedFirst, rejectedSecond]);
    assert.equal(lab.stops, 0, "native work has not settled");
    assert.equal(lab.starts, 1);
    worker.schedule(0);
    await assert.rejects(now(), (error) => error instanceof SyncStopped);
    release();
    await stopped;
    assert.equal(lab.stops, 1);
    assert.equal(lab.maxActive, 1);
    assert.deepEqual(calls.slice(-2), [{ retiring: true, forced: false }, { stop: true }]);
    await advance(60000);
    assert.equal(lab.starts, 2, "no old trigger survives stop");
  });
});

test("two concurrent stops share one retirement and teardown", async () => {
  await withWorker(async ({ lab, runtime, worker }) => {
    await Promise.all([runtime.runPromise(worker.stop()), runtime.runPromise(worker.stop())]);
    assert.equal(lab.stops, 1);
    assert.equal(lab.starts, 1);
  });
});

test("a locked device skips retirement; reconnect can resume the same worker", async () => {
  await withWorker(async ({ lab, runtime, worker, now, advance }) => {
    lab.retire = false;
    await runtime.runPromise(worker.stop());
    assert.equal(lab.starts, 0);
    lab.enabled = true;
    worker.resume();
    await advance();
    await now();
    assert.ok(lab.starts >= 1);
    assert.equal(lab.maxActive, 1);
  });
});

test("failed jobs and defects are reported without killing the worker or exposing native payloads", async () => {
  await withWorker(async ({ lab, diagnostics, now }) => {
    lab.fail = true;
    await now();
    lab.fail = false;
    lab.defect = true;
    await now();
    lab.defect = false;
    await now();
    assert.equal(lab.starts, 3);
    assert.equal(diagnostics.reports.length, 2);
    assert.equal(JSON.stringify(diagnostics.reports).includes("private content"), false);
  });
});

test("a caller's interruption does not cancel its native cycle or release the worker", async () => {
  await withWorker(async ({ lab, advance, hold, worker, runtime, now, diagnostics }) => {
    const release = hold();
    const controller = new AbortController();
    const cancelled = runtime.runPromiseExit(worker.now, { signal: controller.signal });

    await advance();
    controller.abort();
    assert.equal(Exit.isFailure(await cancelled), true);

    const next = now();

    await advance();
    assert.equal(lab.starts, 1);
    release();
    await next;
    assert.equal(lab.starts, 2);
    assert.equal(lab.maxActive, 1);
    assert.equal(diagnostics.reports.length, 0);
  });
});

test("runtime disposal removes subscriptions and waits for a non-cancellable mutation", async () => {
  await withWorker(async ({ lab, worker, runtime, hold, advance, now }) => {
    const release = hold();
    const request = now();
    const rejected = assert.rejects(request);

    await advance();

    let disposed = false;
    const closing = runtime.dispose().then(() => (disposed = true));

    await Promise.resolve();
    assert.equal(disposed, false);
    release();
    await closing;
    await rejected;
    worker.schedule(0);
    assert.equal(lab.starts, 1);
    assert.equal(lab.active, 0);
    assert.equal(lab.listeners, 0);
  });
});

test("failed initialization blocks empty-state cycles without poisoning the runtime", async () => {
  await withWorker(
    async ({ lab, worker, runtime, advance, now, diagnostics }) => {
      await advance();
      assert.equal(lab.starts, 0);
      await assert.rejects(now(), (error) => error instanceof SyncStopped);
      assert.equal(diagnostics.reports.length, 1);
      assert.equal(await runtime.runPromise(Effect.succeed("ready")), "ready");
      worker.resume();
      await advance();
      await now();
      assert.ok(lab.starts > 0, "an explicit successful reconnect can resume work");
    },
    Effect.fail(new SyncFailure({ operation: "initialize", cause: new Error("locked") })),
  );
});

test("failed state loading cannot retire an empty replacement state", async () => {
  await withWorker(
    async ({ lab, worker, runtime, advance }) => {
      await advance();
      await runtime.runPromise(worker.stop());
      assert.equal(lab.starts, 0, "retirement requires a successfully restored state");
      assert.equal(lab.stops, 1);
    },
    Effect.fail(new SyncFailure({ operation: "initialize", cause: new Error("disk unavailable") })),
  );
});

test("cancelling a stop caller does not abandon the accepted stop", async () => {
  await withWorker(async ({ lab, worker, runtime, hold, advance, now }) => {
    const release = hold();
    const syncing = now();
    const rejected = assert.rejects(syncing, (error) => error instanceof SyncStopped);

    await advance();

    const controller = new AbortController();
    const stopped = runtime.runPromiseExit(worker.stop(), { signal: controller.signal });

    await advance();
    controller.abort();
    assert.equal(Exit.isFailure(await stopped), true);
    assert.equal(lab.stops, 0);
    release();
    await advance();
    await rejected;
    assert.equal(lab.stops, 1);
  });
});

test("the slow-cycle indicator is scoped to the native job", async () => {
  await withWorker(async ({ lab, hold, advance, now, worker, runtime }) => {
    const release = hold();
    const syncing = now();

    await advance(999);
    assert.equal(lab.updates, 0);
    await advance(1);
    assert.equal(lab.updates, 1);
    release();
    await syncing;
    lab.retire = false;
    await runtime.runPromise(worker.stop());
    await advance(60000);
    assert.equal(lab.updates, 1, "no progress timer survives stop");
  });
});
