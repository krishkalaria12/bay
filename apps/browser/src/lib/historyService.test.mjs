// The history service (lib/historyService.ts): what it reads, what it keeps, and what it reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const stub = await import("../test-native-stub.mjs");
const { useBrowser, createBrowserStore } = await import("../store/browserStore.ts");
const { AuthorityStore } = await import("../effect/ports/store.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { History, HistoryEngine, HistoryError } = await import("./historyService.ts");
const { engineProfile } = await import("../store/model.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const until = async (ready) => {
  for (let turn = 0; turn < 100; turn++) {
    if (ready()) return;

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail("the expected history work did not finish");
};

// Chrome's history, as a test wants it: what it holds, what it was asked for, and what it refuses.
const fakeEngine = () => {
  const fake = {
    profiles: new Map(),
    watches: [],
    queries: [],
    profileGates: new Map(),
    adds: [],
    // A read waits for this, when it is set.
    gate: null,
    // The old file's move waits for this, when it is set.
    addGate: null,
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
        fake.queries.push(profile);

        if (fake.failure) return Effect.fail(new HistoryError({ operation: { name: "history.query", resource: profile }, cause: fake.failure }));

        const gate = fake.profileGates.get(profile) ?? fake.gate;

        if (!gate) return Effect.succeed(fake.profiles.get(profile) ?? []);

        return Effect.tryPromise({
          try: () => gate.then(() => fake.profiles.get(profile) ?? []),
          catch: (cause) => new HistoryError({ operation: { name: "history.query", resource: profile }, cause }),
        });
      }),
    add: (profile, pages) => {
      const added = Effect.sync(() => {
        if (fake.failure) throw fake.failure;

        fake.adds.push({ profile, pages });

        return pages.length;
      });

      // An add waits for this, when it is set.
      const gate = fake.addGate;

      return gate
        ? Effect.andThen(
            Effect.promise(() => gate),
            added,
          )
        : added;
    },
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

const setup = (browser = useBrowser) => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();
  const layer = History.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, diagnostics.layer, AuthorityStore.layer(browser))));
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

  await runtime.dispose();
});

test("a read that fails is reported once, and the profile stays unread", async () => {
  const { engine, diagnostics, runtime } = setup();

  S().hydrate({});
  engine.failure = new Error("Chrome is gone");

  await read(runtime, "");

  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0].operation.name, "history.read");
  assert.equal(diagnostics.reports[0].operation.resource, "");

  await runtime.dispose();
});

test("a pending profile query does not delay clearing another profile's history", async () => {
  const { engine, runtime } = setup();
  const held = Promise.withResolvers();

  S().hydrate({});
  engine.profiles.set("", [{ url: "https://deleted.example/", title: "Deleted", visits: 1, visitTimes: [1] }]);
  await start(runtime);

  const slow = S().createSpace({ name: "Slow" });
  const slowProfile = engineProfile(slow);

  engine.profileGates.set(slowProfile, held.promise);

  try {
    await until(() => engine.queries.includes(slowProfile));
    engine.profiles.set("", []);
    stub.chromeHistoryChange({ kind: "deleted", profile: "", all: true });

    await until(() => S().history.default?.length === 0);
    assert.equal(engine.queries.filter((profile) => profile === slowProfile).length, 1, "the other profile's query is still pending");
  } finally {
    held.resolve();
    await runtime.dispose();
  }
});

test("a failed query preserves follow-up requests made while it was pending", async () => {
  for (const trigger of ["change", "read"]) {
    const { engine, diagnostics, runtime } = setup();
    const held = Promise.withResolvers();

    S().hydrate({});
    engine.profiles.set("", [{ url: "https://deleted.example/", title: "Deleted", visits: 1, visitTimes: [1] }]);
    await start(runtime);
    engine.profileGates.set("", held.promise);

    const reading = read(runtime, "");
    let followup;

    try {
      await until(() => engine.queries.length === 2);
      engine.profiles.set("", []);

      if (trigger === "change") stub.chromeHistoryChange({ kind: "deleted", profile: "", all: true });
      else followup = read(runtime, "");

      engine.profileGates.delete("");
      held.reject(new Error("The query failed"));
      await Promise.all([reading, followup]);
      await until(() => S().history.default?.length === 0);

      assert.equal(engine.queries.length, 3, "only the requested follow-up query runs after failure");
      assert.equal(diagnostics.reports.length, 1);
    } finally {
      held.resolve();
      await runtime.dispose();
    }
  }
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

  await runtime.dispose();
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

  await runtime.dispose();
});

test("history runtimes update only their own authority store", async (t) => {
  stub.docs.clear();
  const first = createBrowserStore();
  const second = createBrowserStore();
  const a = setup(first);
  const b = setup(second);
  t.after(() => Promise.all([a.runtime.dispose(), b.runtime.dispose()]));
  const legacy = useBrowser.getState();
  a.engine.profiles.set("", [{ url: "https://first.example/", title: "First", visits: 1, visitTimes: [100] }]);
  b.engine.profiles.set("", [{ url: "https://second.example/", title: "Second", visits: 1, visitTimes: [200] }]);

  await Promise.all([read(a.runtime, ""), read(b.runtime, "")]);
  assert.equal(first.getState().history.default[0].url, "https://first.example/");
  assert.equal(second.getState().history.default[0].url, "https://second.example/");
  assert.equal(useBrowser.getState(), legacy);
});

test("a stop while the old file moves in ends that start: nothing is read or shown after it", async () => {
  stub.docs.clear();
  const browser = createBrowserStore();
  const { engine, runtime } = setup(browser);

  browser.getState().hydrate({});
  const visit = Date.now() - 1_000;

  stub.docs.set(
    "history.json",
    JSON.stringify({
      version: 2,
      history: { default: [{ url: "https://old.com/", title: "Old", favicon: null, visits: 1, lastVisit: visit, visitTimes: [visit] }] },
    }),
  );

  let release = () => {};

  engine.addGate = new Promise((resolve) => {
    release = resolve;
  });

  try {
    const starting = start(runtime);

    await tick();
    assert.deepEqual(engine.queries, [], "the views wait for the old file");

    await runtime.runPromise(
      Effect.gen(function* () {
        const history = yield* History;

        yield* history.stop;
      }),
    );

    release();
    await starting;
    await tick();

    assert.deepEqual(engine.queries, [], "the stopped start reads nothing");
    assert.deepEqual(browser.getState().historyReady, {}, "the stopped start marks nothing ready");
  } finally {
    stub.docs.delete("history.json");
    await runtime.dispose();
  }
});
