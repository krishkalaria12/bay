// The delivery (telemetry/service.ts): the queue goes out on the app's shared grid, one batch at a time, and the
// user can turn sharing off while a request is in flight.
//
// The tests drive the service with a fake collector and a fake queue: nothing goes over the network, and the test
// waits for what it expects rather than for a fixed time.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { BATCH_SIZE } = await import("./config.ts");
const { DiagnosticsService, TelemetryEngine, TelemetryError } = await import("./service.ts");
const { fakeDiagnostics, fakeScheduler } = await import("../effect/testing.ts");

// The service works in fibers: the test waits for what it expects rather than for a fixed time.
const until = async (ready, what) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (ready()) return;

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.fail(`the test's condition never came: ${what}`);
};

// The collector, without a network: it keeps what it was asked to send, and answers what the test says.
const fakeCollector = () => {
  const uploads = [];
  const written = [];
  const waiting = [];
  let reply = { status: 200, dryRun: false, retryAfterMs: undefined };
  let held = false;
  let failures = 0;

  const layer = Layer.succeed(TelemetryEngine)({
    upload: (request) =>
      Effect.suspend(() => {
        uploads.push(request);

        // A network that is not there: the request fails before the collector answers it.
        if (failures > 0) {
          failures--;

          return Effect.fail(
            new TelemetryError({ operation: { name: "telemetry.upload", resource: request.url }, cause: new Error("the network is not there") }),
          );
        }

        if (!held) return Effect.succeed(reply);

        return Effect.tryPromise({
          try: (signal) =>
            new Promise((resolve, reject) => {
              // The delivery is cancelled: the request is stopped with it.
              signal.addEventListener("abort", () => reject(new Error("the request was stopped")));

              waiting.push({ resolve, reject, request });
            }),
          catch: (cause) => new TelemetryError({ operation: { name: "telemetry.upload", resource: request.url }, cause }),
        });
      }),
    readQueue: () => Effect.succeed(null),
    writeQueue: (contents) => Effect.sync(() => void written.push(contents)),
  });

  return {
    layer,
    uploads,
    written,
    waiting,
    /** Answers every upload that follows with this status. */
    answer: (status) => {
      reply = { status, dryRun: false, retryAfterMs: undefined };
    },
    /** Holds every upload that follows, until the test answers it. */
    hold: () => {
      held = true;
    },
    /** The next uploads fail, as a network that is not there would. */
    fail: (times) => {
      failures = times;
    },
    /** The collector says when it will take the batch again. */
    retryAfter: (ms) => {
      reply = { ...reply, retryAfterMs: ms };
    },
  };
};

// The app's plain side of the telemetry: the queue, the consent, and the opt-out its own code performs.
const fakeConsole = () => {
  const events = [];
  const logs = [];
  const inflight = new Set();
  const requests = [];
  const removed = [];
  const listeners = new Set();
  let generation = 0;
  let sharing = true;
  let bodyBytes = 0;

  const view = (kind, list) => ({
    kind,
    take: () => list,
    // A body of more than one record is as large as the test says it is: the collector will not take it.
    body: (batch) => JSON.stringify({ records: batch, padding: batch.length > 1 ? "x".repeat(bodyBytes) : "" }),
    remove: (batch) => {
      removed.push([kind, batch.length]);

      for (const record of batch) list.splice(list.indexOf(record), 1);
    },
  });

  const console = {
    sharing: () => sharing,
    generation: () => generation,
    events: view("events", events),
    logs: view("logs", logs),
    inflight,
    recorded: (entry) => void requests.push(entry),
    serialized: () => JSON.stringify({ version: 1, events, logs }),
    restore: (contents) => {
      const stored = JSON.parse(contents);

      events.unshift(...(stored.events ?? []));
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };

  return {
    console,
    events,
    logs,
    inflight,
    requests,
    removed,
    /** The opt-out, the way the app's own code does it: the generation moves, the uploads stop and the queue goes. */
    optOut: () => {
      generation++;
      sharing = false;

      for (const stop of inflight) stop();

      inflight.clear();
      events.length = 0;
      logs.length = 0;
    },
    /** Whether the user shares diagnostics. */
    share: (on) => {
      sharing = on;
    },
    /** How large the body of a batch is, so a batch the collector will not take can be made. */
    bodyBytes: (bytes) => {
      bodyBytes = bytes;
    },
  };
};

const record = (uuid) => ({ uuid, event: "opened", distinct_id: "bay", timestamp: "2026-01-01T00:00:00.000Z", properties: {} });

const withService = async (use, engine) => {
  const collector = fakeCollector();
  const scheduler = fakeScheduler();
  const diagnostics = fakeDiagnostics();

  // The app's clock. The service reads the time from it, and the test is what moves it: the same layer is given to
  // the service and merged into the runtime, so both see one clock.
  const clock = TestClock.layer();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DiagnosticsService.layer.pipe(Layer.provide(Layer.mergeAll(engine ?? collector.layer, scheduler.layer, diagnostics.layer, clock))), clock),
  );

  // The service waits on the clock the test controls, so a retry does not cost the test real time.
  const advance = (ms) => runtime.runPromise(TestClock.adjust(ms));

  try {
    return await use({ runtime, collector, scheduler, diagnostics, advance });
  } finally {
    await runtime.dispose();
  }
};

const deliver = (runtime, console) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* DiagnosticsService;

      yield* service.start(console);
      yield* service.deliver();
    }),
  );

// The grid's slot, run on the app's runtime. In the app the job runs there, on the app's clock, and the test wants
// the same: nothing in it may depend on the wall clock.
const fire = (runtime, scheduler) =>
  runtime.runPromise(
    Effect.gen(function* () {
      for (const job of scheduler.jobs.slice()) yield* job.run;
    }),
  );

test("the opt-out stops the upload and empties the queue at once", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    collector.hold();
    telemetry.events.push(record("one"));

    const delivery = deliver(runtime, telemetry.console);

    // The upload is in flight, and the app's opt-out has something to stop.
    await until(() => collector.uploads.length === 1, "the upload to start");
    assert.equal(telemetry.inflight.size, 1, "the service told the app what was in flight");

    telemetry.optOut();

    assert.equal(collector.waiting[0].request.signal.aborted, true, "the upload was stopped");
    assert.deepEqual(telemetry.events, [], "the queue is empty at once");

    // The answer that comes after the opt-out belongs to a queue that is gone.
    collector.waiting[0].resolve({ status: 200, dryRun: false });

    await delivery;

    assert.deepEqual(telemetry.removed, [], "the late answer took nothing out of the queue");
    assert.deepEqual(collector.written, [], "nothing was written after the opt-out");
  });
});

test("the delivery runs on the app's shared grid", async () => {
  await withService(async ({ runtime, collector, scheduler }) => {
    const telemetry = fakeConsole();

    telemetry.events.push(record("one"));

    await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* DiagnosticsService;

        yield* service.start(telemetry.console);
      }),
    );

    assert.equal(scheduler.jobs.length, 1, "the delivery is a job on the grid");
    assert.equal(collector.uploads.length, 0, "nothing goes out before the slot comes round");

    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 1, "the slot sent the queue");
    assert.deepEqual(telemetry.events, [], "the queue is empty once it is sent");
  });
});

test("a queue that is over the limit goes out in batches", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    // More records than one batch holds.
    for (let index = 0; index < BATCH_SIZE * 2 + 50; index++) telemetry.events.push(record(`event-${index}`));

    await deliver(runtime, telemetry.console);

    assert.deepEqual(
      collector.uploads.map((upload) => JSON.parse(upload.body).records.length),
      [BATCH_SIZE, BATCH_SIZE, 50],
      "the queue went out in the batches the settings say",
    );
    assert.deepEqual(telemetry.events, [], "the queue is empty once it is sent");
  });
});

test("a batch the collector will not take is sent in smaller pieces", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    collector.answer(413);
    telemetry.events.push(record("one"), record("two"), record("three"), record("four"));

    await deliver(runtime, telemetry.console);

    assert.deepEqual(
      collector.uploads.map((upload) => JSON.parse(upload.body).records.length),
      [4, 2, 1, 1, 1, 1],
      "the batch was halved until every record went out on its own",
    );
    assert.deepEqual(telemetry.events, [], "the queue is empty once it is sent");
  });
});

test("a body the collector will not take is sent in smaller pieces", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    telemetry.bodyBytes(600_000);
    telemetry.events.push(record("one"), record("two"), record("three"), record("four"));

    await deliver(runtime, telemetry.console);

    assert.deepEqual(
      collector.uploads.map((upload) => JSON.parse(upload.body).records.length),
      [1, 1, 1, 1],
      "the body was halved until each record went out on its own",
    );
    assert.deepEqual(telemetry.events, [], "the queue is empty once it is sent");
  });
});

test("nothing goes out while the user shares nothing", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    telemetry.share(false);
    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    assert.deepEqual(collector.uploads, [], "the queue stays where it is");
    assert.equal(telemetry.events.length, 1, "the queue is untouched");
  });
});

test("a collector that is not there leaves the queue for the next try", async () => {
  await withService(async ({ runtime, collector, diagnostics }) => {
    const telemetry = fakeConsole();

    collector.answer(500);
    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    assert.equal(telemetry.events.length, 1, "the batch is kept");
    assert.equal(diagnostics.reports.length, 1, "the failure was reported once, where every other failure goes");
  });
});

test("a request that fails is tried twice more, and reported once", async () => {
  await withService(async ({ runtime, collector, diagnostics, advance }) => {
    const telemetry = fakeConsole();

    // The network is not there: every request fails.
    collector.fail(10);

    telemetry.events.push(record("one"));

    const delivery = deliver(runtime, telemetry.console);

    await until(() => collector.uploads.length === 1, "the first try");

    // The delivery waits before it tries again, and the clock is what moves it on.
    await advance(1_000);
    await until(() => collector.uploads.length === 2, "the second try");

    await advance(2_000);
    await until(() => collector.uploads.length === 3, "the third try");

    await delivery;

    assert.equal(collector.uploads.length, 3, "the request was tried three times, and no more");
    assert.equal(diagnostics.reports.length, 1, "the failure was reported once");
    assert.equal(telemetry.events.length, 1, "the batch is kept for the next delivery");
  });
});

test("a rate limit waits for the timing the collector gave", async () => {
  await withService(async ({ runtime, collector, scheduler, advance }) => {
    const telemetry = fakeConsole();

    collector.answer(429);
    collector.retryAfter(120_000);

    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    assert.equal(telemetry.events.length, 1, "the batch is kept");

    // The collector said it would take the batch in two minutes: the delivery waits for that.
    await advance(60_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 1, "the delivery did not go out before the collector's timing");

    await advance(60_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 2, "the delivery went out when the collector's timing arrived");
  });
});

test("the slot and the delivery read the same clock, wherever the slot runs", async () => {
  await withService(async ({ runtime, collector, scheduler, advance }) => {
    const telemetry = fakeConsole();

    collector.answer(429);
    collector.retryAfter(120_000);

    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    // The slot runs on its own, away from the app's runtime: it still reads the app's clock, so the two cannot
    // disagree about when the collector's timing is up.
    await advance(60_000);
    await scheduler.fire();

    assert.equal(collector.uploads.length, 1, "the delivery did not go out before the collector's timing");

    await advance(60_000);
    await scheduler.fire();

    assert.equal(collector.uploads.length, 2, "the delivery went out when the collector's timing arrived");
  });
});

test("the app's own ask waits for the collector's timing as well", async () => {
  await withService(async ({ runtime, collector, advance }) => {
    const telemetry = fakeConsole();

    collector.answer(429);
    collector.retryAfter(120_000);

    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    assert.equal(collector.uploads.length, 1, "the batch was sent once");

    // The app asks for the queue again: the collector's timing still holds.
    await deliver(runtime, telemetry.console);

    assert.equal(collector.uploads.length, 1, "the delivery waited for the collector's timing");

    await advance(120_000);

    await deliver(runtime, telemetry.console);

    assert.equal(collector.uploads.length, 2, "the delivery went out when the collector's timing arrived");
  });
});

test("a batch in flight is not sent a second time", async () => {
  await withService(async ({ runtime, collector }) => {
    const telemetry = fakeConsole();

    collector.hold();
    telemetry.events.push(record("one"));

    const delivery = deliver(runtime, telemetry.console);

    await until(() => collector.uploads.length === 1, "the upload to start");

    // The app asks again while the request is out: the batch goes out once.
    await deliver(runtime, telemetry.console);

    assert.equal(collector.uploads.length, 1, "the batch in flight was not sent again");

    collector.waiting[0].resolve({ status: 200, dryRun: false });

    await delivery;

    assert.equal(collector.uploads.length, 1, "only one batch went out");
  });
});

test("the wait after a failure grows with the failures in a row", async () => {
  await withService(async ({ runtime, collector, scheduler, advance }) => {
    const telemetry = fakeConsole();

    collector.answer(500);

    telemetry.events.push(record("one"));

    await deliver(runtime, telemetry.console);

    assert.equal(collector.uploads.length, 1, "the batch was sent");

    // The first failure waits half a minute.
    await advance(29_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 1, "the delivery waited");

    await advance(1_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 2, "the delivery went out when the wait was over");

    // The second failure in a row waits twice as long.
    await advance(59_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 2, "the delivery waited for the longer wait");

    await advance(1_000);
    await fire(runtime, scheduler);

    assert.equal(collector.uploads.length, 3, "the delivery went out when the longer wait was over");
  });
});

test("a build that does not send writes the request down and sends nothing", async () => {
  // A development build only sends when it is asked to, and this one was not.
  globalThis.__DEV__ = true;

  try {
    await withService(async ({ runtime }) => {
      const telemetry = fakeConsole();

      telemetry.events.push(record("one"));

      await deliver(runtime, telemetry.console);

      assert.deepEqual(telemetry.events, [], "the batch is gone, as it is in a build that only writes it down");
      assert.equal(telemetry.requests.length, 1, "the request was written down");
      assert.equal(telemetry.requests[0].dryRun, true, "the request was a dry run");
      assert.equal(telemetry.requests[0].status, null, "a request that never went out has no status");
    }, TelemetryEngine.layer);
  } finally {
    globalThis.__DEV__ = false;
  }
});

test("a cancelled delivery stays silent", async () => {
  await withService(async ({ runtime, collector, diagnostics }) => {
    const telemetry = fakeConsole();

    collector.hold();
    telemetry.events.push(record("one"));

    const controller = new AbortController();

    const delivery = runtime.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* DiagnosticsService;

        yield* service.start(telemetry.console);
        yield* service.deliver();
      }),
      { signal: controller.signal },
    );

    await until(() => collector.uploads.length === 1, "the upload to start");

    // The delivery is cancelled while the request is out.
    controller.abort();

    const exit = await delivery;

    assert.equal(Exit.isFailure(exit), true, "the delivery was cancelled");
    assert.equal(diagnostics.reports.length, 0, "a cancelled delivery is not a telemetry incident");
    assert.deepEqual(telemetry.removed, [], "the queue is left as it was");
  });
});

test("the app's own opt-out clears the queue and the identity at once", async () => {
  // The app's build defines this; a test has to as well.
  globalThis.__DEV__ = false;

  const { telemetryConsole, setSharing, devState } = await import("./client.ts");
  const stub = await import("../test-native-stub.mjs");

  stub.docs.clear();

  await withService(async ({ runtime, collector }) => {
    collector.hold();

    setSharing(true, "settings");

    assert.ok(devState().saved.installId, "the app has an identity while it shares");

    const delivery = deliver(runtime, telemetryConsole);

    await until(() => collector.uploads.length === 1, "the upload to start");
    assert.equal(telemetryConsole.inflight.size, 1, "the service told the app what was in flight");

    // The user turns sharing off: the generation moves, the uploads stop, and the queue and the identity go.
    setSharing(false, "settings");

    assert.equal(collector.waiting[0].request.signal.aborted, true, "the upload was stopped");
    assert.equal(devState().saved.installId, null, "the identity is gone");
    assert.deepEqual(devState().queued, { events: 0, logs: 0 }, "the queue is empty at once");
    assert.deepEqual(JSON.parse(stub.docs.get("telemetry-queue.json")), { version: 1, events: [], logs: [] }, "the queue on disk is empty at once");

    // The answer that comes after the opt-out belongs to a queue that is gone.
    collector.waiting[0].resolve({ status: 200, dryRun: false });

    await delivery;

    assert.deepEqual(collector.written, [], "nothing was written after the opt-out");
  });
});
