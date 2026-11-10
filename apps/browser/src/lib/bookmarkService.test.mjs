// The bookmarks service (lib/bookmarkService.ts): what it reads, what it sends, and what it reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browserStore.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");
const { Bookmarks, BookmarkEngine, BookmarkError } = await import("./bookmarkService.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// Chrome's bookmarks, as a test wants them: the tree it holds, the ops it was sent, and what it refuses.
const fakeEngine = () => {
  const empty = { bar: { id: "bar", k: "f", t: "Bookmarks Bar", a: 0, c: [] }, other: { id: "other", k: "f", t: "Other Bookmarks", a: 0, c: [] } };

  const fake = {
    trees: new Map(),
    applied: [],
    watches: [],
    // The failure the read or the apply meets, when there is one.
    failure: null,
  };

  const layer = Layer.succeed(BookmarkEngine)({
    watch: (engine) =>
      Effect.sync(() => {
        fake.watches.push(engine);
      }),
    tree: (engine) =>
      Effect.suspend(() => {
        if (fake.failure) return Effect.fail(new BookmarkError({ operation: { name: "bookmarks.tree", resource: engine }, cause: fake.failure }));

        return Effect.succeed(fake.trees.get(engine) ?? empty);
      }),
    apply: (engine, ops) =>
      Effect.sync(() => {
        if (fake.failure) throw fake.failure;

        fake.applied.push({ engine, ops });

        return { skipped: 0, invalid: [] };
      }),
  });

  return { layer, fake };
};

const setup = () => {
  const engine = fakeEngine();
  const diagnostics = fakeDiagnostics();
  const layer = Bookmarks.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, diagnostics.layer)));
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

  await tick();

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
