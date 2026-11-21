// The bookmarks service (lib/bookmarkService.ts): what it reads, what it sends, and what it reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const stub = await import("../test-native-stub.mjs");
const { useBrowser, createBrowserStore } = await import("../store/browserStore.ts");
const { AuthorityStore } = await import("../effect/ports/store.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { Bookmarks, BookmarkEngine, BookmarkError } = await import("./bookmarkService.ts");
const { engineProfile } = await import("../store/model.ts");

const S = () => useBrowser.getState();

const until = async (ready) => {
  for (let turn = 0; turn < 100; turn++) {
    if (ready()) return;

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail("the expected bookmark work did not finish");
};

// Chrome's bookmarks, as a test wants them: the tree it holds, the ops it was sent, and what it refuses.
const fakeEngine = () => {
  const empty = { bar: { id: "bar", k: "f", t: "Bookmarks Bar", a: 0, c: [] }, other: { id: "other", k: "f", t: "Other Bookmarks", a: 0, c: [] } };

  const fake = {
    trees: new Map(),
    applied: [],
    appliedOnce: Promise.withResolvers(),
    watches: [],
    reads: [],
    gates: new Map(),
    // The failure the read or the apply meets, when there is one.
    failure: null,
    applyFailure: null,
    applyGate: null,
  };

  const layer = Layer.succeed(BookmarkEngine)({
    watch: (engine) =>
      Effect.sync(() => {
        fake.watches.push(engine);
      }),
    tree: (engine) =>
      Effect.suspend(() => {
        fake.reads.push(engine);

        if (fake.failure) return Effect.fail(new BookmarkError({ operation: { name: "bookmarks.tree", resource: engine }, cause: fake.failure }));

        const gate = fake.gates.get(engine);

        return gate
          ? Effect.tryPromise({
              try: () => gate.then(() => fake.trees.get(engine) ?? empty),
              catch: (cause) => new BookmarkError({ operation: { name: "bookmarks.tree", resource: engine }, cause }),
            })
          : Effect.succeed(fake.trees.get(engine) ?? empty);
      }),
    apply: (engine, ops) =>
      Effect.suspend(() => {
        // An apply waits for this, when it is set.
        if (fake.applyGate) {
          const gate = fake.applyGate;

          fake.applyGate = null;

          return Effect.andThen(
            Effect.promise(() => gate),
            Effect.sync(() => ({ skipped: 0, invalid: [] })),
          );
        }

        if (fake.applyFailure) {
          const cause = fake.applyFailure;

          fake.applyFailure = null;

          return Effect.fail(new BookmarkError({ operation: { name: "bookmarks.apply", resource: engine }, cause }));
        }

        return Effect.sync(() => {
          if (fake.failure) throw fake.failure;

          fake.applied.push({ engine, ops });
          fake.appliedOnce.resolve();

          return { skipped: 0, invalid: [] };
        });
      }),
  });

  return { layer, fake };
};

const setup = (browser = useBrowser) => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();
  const layer = Bookmarks.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, diagnostics.layer, AuthorityStore.layer(browser))));
  const runtime = ManagedRuntime.make(layer);

  return { engine: engine.fake, diagnostics, runtime };
};

const start = (runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.start;
    }),
  );

const stop = (runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.stop;
    }),
  );

test("a read shows Chrome's tree", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  engine.trees.set("", {
    bar: { id: "bar", k: "f", t: "Bookmarks Bar", a: 0, c: [{ id: "a", k: "u", t: "A", u: "https://a.example/", a: 1 }] },
    other: { id: "other", k: "f", t: "Other Bookmarks", a: 0, c: [] },
  });

  await start(runtime);

  assert.deepEqual(engine.watches, [""]);
  assert.equal(S().bookmarks.nodes.a?.title, "A");
  assert.ok(S().bookmarksReady.default);

  await stop(runtime);
});

test("the store's edits go to Chrome as ops", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  engine.trees.set("", {
    bar: { id: "bar", k: "f", t: "Bookmarks Bar", a: 0, c: [] },
    other: { id: "other", k: "f", t: "Other Bookmarks", a: 0, c: [] },
  });

  await start(runtime);

  const added = S().addBookmark({ spaceId: "default", url: "https://a.example/", title: "A" });

  await engine.appliedOnce.promise;

  assert.ok(added);
  assert.ok(engine.applied.length > 0, "the edit went to Chrome");
  assert.equal(engine.applied.at(-1).ops.at(-1).op, "add");

  await stop(runtime);
});

test("a read that fails is reported once, and Chrome's tree is not shown", async () => {
  const { engine, diagnostics, runtime } = setup();

  S().hydrate({});
  engine.failure = new Error("Chrome is gone");

  await start(runtime);

  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0].operation.name, "bookmarks.work");
  assert.equal(diagnostics.reports[0].operation.resource, "");

  await stop(runtime);
});

test("an apply failure is reported even when reconciliation succeeds", async () => {
  const { engine, diagnostics, runtime } = setup();

  S().hydrate({});
  await start(runtime);
  engine.applyFailure = new Error("Chrome refused the edit");

  try {
    S().addBookmark({ spaceId: "default", url: "https://a.example/", title: "A" });
    await engine.appliedOnce.promise;

    assert.equal(diagnostics.reports.length, 1);
    assert.equal(diagnostics.reports[0].operation.name, "bookmarks.apply");
    assert.equal(diagnostics.reports[0].cause.cause.message, "Chrome refused the edit");
  } finally {
    await stop(runtime);
    await runtime.dispose();
  }
});

test("a pending profile read does not block other profiles' reads or bookmark edits", async () => {
  const { engine, runtime } = setup();
  const held = Promise.withResolvers();

  S().hydrate({});
  await start(runtime);

  const slow = S().createSpace({ name: "Slow" });
  const slowProfile = engineProfile(slow);

  engine.gates.set(slowProfile, held.promise);

  try {
    await until(() => engine.reads.includes(slowProfile));

    const healthy = S().createSpace({ name: "Healthy" });
    const healthyProfile = engineProfile(healthy);

    await until(() => S().bookmarksReady[healthy]);
    const added = S().addBookmark({ spaceId: healthy, url: "https://healthy.example/", title: "Healthy" });

    await until(() => engine.applied.some((batch) => batch.engine === healthyProfile));
    assert.ok(added);
    assert.equal(S().bookmarksReady[slow], undefined, "the unrelated profile is still waiting on Chrome");
    assert.equal(engine.reads.filter((profile) => profile === slowProfile).length, 1, "its queued reads coalesce");
  } finally {
    held.resolve();
    await stop(runtime);
    await runtime.dispose();
  }
});

test("an edit queued during a failed read still reaches Chrome", async () => {
  const { engine, diagnostics, runtime } = setup();
  const held = Promise.withResolvers();

  S().hydrate({});
  await start(runtime);
  engine.applied.length = 0;
  engine.gates.set("", held.promise);

  const reading = runtime.runPromise(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.read("");
    }),
  );

  try {
    await until(() => engine.reads.filter((profile) => profile === "").length === 2);
    S().addBookmark({ spaceId: "default", url: "https://queued.example/", title: "Queued" });

    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
    engine.gates.delete("");
    held.reject(new Error("The read failed"));
    await reading;
    await until(() => engine.applied.some((batch) => batch.engine === ""));

    assert.equal(diagnostics.reports.length, 1);
    assert.equal(engine.applied.find((batch) => batch.engine === "").ops.at(-1).u, "https://queued.example/");
  } finally {
    held.resolve();
    await stop(runtime);
    await runtime.dispose();
  }
});

test("startup reads each profile without waiting for another profile's native tree", async () => {
  const { engine, runtime } = setup();
  const held = Promise.withResolvers();

  S().hydrate({});
  const slow = S().createSpace({ name: "Slow" });
  const healthy = S().createSpace({ name: "Healthy" });

  engine.gates.set(engineProfile(slow), held.promise);
  const starting = start(runtime);

  try {
    await until(() => S().bookmarksReady[healthy]);
    assert.equal(S().bookmarksReady[slow], undefined);
  } finally {
    held.resolve();
    await starting;
    await stop(runtime);
    await runtime.dispose();
  }
});

test("the app's old bookmarks.json is moved into Chrome, and deleted only once it is there", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  stub.docs.set(
    "bookmarks.json",
    JSON.stringify({
      version: 2,
      bookmarks: {
        roots: { default: { bar: "bm-bar", other: "bm-other" } },
        nodes: {
          "bm-bar": { id: "bm-bar", parentId: null, kind: "folder", title: "Bookmarks Bar", children: ["bm-a"], addedAt: 1 },
          "bm-other": { id: "bm-other", parentId: null, kind: "folder", title: "Other Bookmarks", children: [], addedAt: 1 },
          "bm-a": { id: "bm-a", parentId: "bm-bar", kind: "url", title: "A", url: "https://a.example/", favicon: null, addedAt: 1 },
        },
      },
    }),
  );

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      return yield* bookmarks.migrate({ keepMs: 0 });
    }),
  );

  assert.equal(result, "moved");
  assert.equal(engine.applied.length, 1);
  assert.equal(engine.applied[0].ops.length, 1);
  assert.equal(engine.applied[0].ops[0].op, "add");
  assert.equal(stub.docs.has("bookmarks.json"), false, "the file is deleted once Chrome has the bookmarks");

  await stop(runtime);
});

test("a move that fails keeps the file, for the next launch", async () => {
  const { engine, runtime } = setup();

  S().hydrate({});
  stub.docs.set(
    "bookmarks.json",
    JSON.stringify({
      version: 2,
      bookmarks: {
        roots: { default: { bar: "bm-bar", other: "bm-other" } },
        nodes: {
          "bm-bar": { id: "bm-bar", parentId: null, kind: "folder", title: "Bookmarks Bar", children: ["bm-a"], addedAt: 1 },
          "bm-other": { id: "bm-other", parentId: null, kind: "folder", title: "Other Bookmarks", children: [], addedAt: 1 },
          "bm-a": { id: "bm-a", parentId: "bm-bar", kind: "url", title: "A", url: "https://a.example/", favicon: null, addedAt: 1 },
        },
      },
    }),
  );
  engine.failure = new Error("Chrome refused");

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      return yield* bookmarks.migrate({ keepMs: 0 });
    }),
  );

  assert.equal(result, "kept");
  assert.ok(stub.docs.has("bookmarks.json"), "the file is kept");

  await stop(runtime);
});

test("bookmark runtimes update only their own authority store", async (t) => {
  stub.docs.clear();
  const first = createBrowserStore();
  const second = createBrowserStore();
  const a = setup(first);
  const b = setup(second);
  t.after(() => Promise.all([a.runtime.dispose(), b.runtime.dispose()]));
  const legacy = useBrowser.getState();

  const tree = (id, title) => ({
    bar: { id: "bar", k: "f", t: "Bookmarks Bar", a: 0, c: [{ id, k: "u", t: title, u: `https://${title}.example/`, a: 1 }] },
    other: { id: "other", k: "f", t: "Other Bookmarks", a: 0, c: [] },
  });

  a.engine.trees.set("", tree("11111111-1111-4111-8111-111111111111", "first"));
  b.engine.trees.set("", tree("22222222-2222-4222-8222-222222222222", "second"));

  await Promise.all([start(a.runtime), start(b.runtime)]);
  assert.ok(Object.values(first.getState().bookmarks.nodes).some((node) => node.title === "first"));
  assert.equal(
    Object.values(first.getState().bookmarks.nodes).some((node) => node.title === "second"),
    false,
  );
  assert.ok(Object.values(second.getState().bookmarks.nodes).some((node) => node.title === "second"));
  assert.equal(useBrowser.getState(), legacy);
});

test("a stop while the old file moves in ends that start: no tree is read or shown after it", async () => {
  const browser = createBrowserStore();
  const { engine, runtime } = setup(browser);

  browser.getState().hydrate({});
  stub.docs.set(
    "bookmarks.json",
    JSON.stringify({
      version: 2,
      bookmarks: {
        roots: { default: { bar: "bm-bar", other: "bm-other" } },
        nodes: {
          "bm-bar": { id: "bm-bar", parentId: null, kind: "folder", title: "Bookmarks Bar", children: ["bm-a"], addedAt: 1 },
          "bm-other": { id: "bm-other", parentId: null, kind: "folder", title: "Other Bookmarks", children: [], addedAt: 1 },
          "bm-a": { id: "bm-a", parentId: "bm-bar", kind: "url", title: "A", url: "https://a.example/", favicon: null, addedAt: 1 },
        },
      },
    }),
  );

  const moving = Promise.withResolvers();

  engine.applyGate = moving.promise;

  try {
    const starting = start(runtime);

    await new Promise((resolve) => setImmediate(resolve));
    await stop(runtime);
    moving.resolve();
    await starting;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(engine.reads, [], "the stopped start reads no tree");
    assert.deepEqual(browser.getState().bookmarksReady, {}, "the stopped start marks nothing ready");
  } finally {
    stub.docs.delete("bookmarks.json");
    await runtime.dispose();
  }
});
