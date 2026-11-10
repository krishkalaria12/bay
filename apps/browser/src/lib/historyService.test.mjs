// The history service (lib/historyService.ts): what it reads, what it keeps, and what it reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browserStore.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { History, HistoryEngine, HistoryError } = await import("./historyService.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Chrome's history, as a test wants it: what it holds, what it was asked for, and what it refuses.
const fakeEngine = () => {
  const fake = {
    profiles: new Map(),
    watches: [],
    adds: [],
    // A read waits for this, when it is set.
    gate: null,
    // The failure the read or the add meets, when there is one.
    failure: null,
  };

  const layer = Layer.succeed(HistoryEngine)({
    watch: (profile) =>
      Effect.sync(() => {
        fake.watches.push(profile);
      }),
    query: (profile) =>
      Effect.suspend(() => {
        if (fake.failure) return Effect.fail(new HistoryError({ operation: { name: "history.query", resource: profile }, cause: fake.failure }));

        const gate = fake.gate;

        if (!gate) return Effect.succeed(fake.profiles.get(profile) ?? []);

        return Effect.promise(() => gate.then(() => fake.profiles.get(profile) ?? []));
      }),
    add: (profile, pages) =>
      Effect.sync(() => {
        if (fake.failure) throw fake.failure;

        fake.adds.push({ profile, pages });

        return pages.length;
      }),
  });

  return {
    layer,
    fake,
    /** Holds the next read until the returned function is called. */
    hold: () => {
      let release = () => {};

      fake.gate = new Promise((resolve) => {
        release = resolve;
      });

      return () => {
        fake.gate = null;
        release();
      };
    },
  };
};

const setup = () => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();
  const layer = History.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, diagnostics.layer)));
  const runtime = ManagedRuntime.make(layer);

  return { engine: engine.fake, hold: engine.hold, diagnostics, runtime };
};

const read = (runtime, profile) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const history = yield* History;

      yield* history.read(profile);
    }),
  );

const start = (runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const history = yield* History;

      yield* history.start;
    }),
  );

test("a read shows the profile's history", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  engine.profiles.set("", [{ url: "https://a.com/", title: "A", visits: 1, visitTimes: [1] }]);

  await read(runtime, "");

  assert.deepEqual(
    S().history.default?.map((h) => h.url),
    ["https://a.com/"],
  );
  assert.deepEqual(engine.watches, [""]);
});

test("a change that arrives while a read is running is kept, and shown", async () => {
  const { engine, hold, runtime } = setup();

  S().hydrate({});
  engine.profiles.set("", [{ url: "https://a.com/", title: "A", visits: 1, visitTimes: [1] }]);

  await start(runtime);

  const release = hold();
  const reading = read(runtime, "");

  await tick();

  // A visit Chrome reports while the read is running: it is not in the list the read will find.
  stub.chromeHistoryChange({ kind: "visit", profile: "", url: "https://late.com/", title: "Late", visits: 1, at: 2 });
  await tick();

  release();
  await reading;

  assert.deepEqual(
    S().history.default?.map((h) => h.url),
    ["https://late.com/", "https://a.com/"],
    "the visit that arrived during the read is not lost",
  );
});

test("a read that fails is reported once, and the profile stays unread", async () => {
  const { engine, diagnostics, runtime } = setup();

  S().hydrate({});
  engine.failure = new Error("Chrome is gone");

  await read(runtime, "");

  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0].operation.name, "history.read");
  assert.equal(diagnostics.reports[0].operation.resource, "");
});

test("the app's old history.json is moved into Chrome, and deleted only once it is there", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  const visit = Date.now() - 1_000;

  stub.docs.set(
    "history.json",
    JSON.stringify({
      version: 2,
      history: { default: [{ url: "https://old.com/", title: "Old", favicon: null, visits: 1, lastVisit: visit, visitTimes: [visit] }] },
    }),
  );

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const history = yield* History;

      return yield* history.migrate({ keepMs: 0 });
    }),
  );

  assert.equal(result, "moved");
  assert.equal(engine.adds.length, 1);
  assert.equal(engine.adds[0].pages[0].url, "https://old.com/");
  assert.equal(stub.docs.has("history.json"), false, "the file is deleted once Chrome has the visits");
});

test("a move that fails keeps the file, for the next launch", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  const visit = Date.now() - 1_000;

  stub.docs.set(
    "history.json",
    JSON.stringify({
      version: 2,
      history: { default: [{ url: "https://old.com/", title: "Old", favicon: null, visits: 1, lastVisit: visit, visitTimes: [visit] }] },
    }),
  );
  engine.failure = new Error("Chrome refused");

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const history = yield* History;

      return yield* history.migrate({ keepMs: 0 });
    }),
  );

  assert.equal(result, "kept");
  assert.ok(stub.docs.has("history.json"), "the file is kept");
});
