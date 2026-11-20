// The browsing state on disk (src/store/persistence.ts): a burst of changes is written once, a failed write is written
// again by the next change or by leaving the foreground, and a launch falls back on each kind of unreadable file.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { BrowserState } from "../src/effect/ports/browserState.ts";
import { FileError, Files } from "../src/effect/ports/files.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, fakeFiles, fakeLifecycle, withTestClock } from "../src/effect/testing.ts";
import { createTab, initialBrowserData } from "../src/store/model.ts";
import { Persistence, PRUNE_DELAY, SAVE_DELAY, STATE_FILE } from "../src/store/persistence.ts";

const SAVED = `document/${STATE_FILE}`;

/** The fakes a persistence test runs against, with a disk that counts its writes and can be told to fail. */
const harness = () => {
  const diagnostics = fakeDiagnostics();
  const files = fakeFiles();
  const engine = fakeEngine();
  const lifecycle = fakeLifecycle();
  const browserState = fakeBrowserState();
  const disk = { writes: 0, failWrites: 0, failReads: false };

  const countingFiles = Layer.effect(
    Files,
    Effect.gen(function* () {
      const inner = yield* Files;

      return Files.of({
        ...inner,
        read: (root, path) =>
          disk.failReads
            ? Effect.fail(new FileError({ operation: { name: "files.read", resource: path }, cause: new Error("permission denied") }))
            : inner.read(root, path),
        write: (root, path, contents) =>
          Effect.suspend(() => {
            if (disk.failWrites > 0) {
              disk.failWrites -= 1;

              return Effect.fail(new FileError({ operation: { name: "files.write", resource: path }, cause: new Error("disk full") }));
            }

            disk.writes += 1;

            return inner.write(root, path, contents);
          }),
      });
    }),
  ).pipe(Layer.provide(files.layer));

  const layer = Persistence.layer.pipe(Layer.provide(Layer.mergeAll(countingFiles, diagnostics.layer, engine.layer, lifecycle.layer, browserState.layer)));

  /** Runs a test program with persistence and the store in place, under the test clock. */
  const run = <A>(program: Effect.Effect<A, never, Persistence | BrowserState | TestClock.TestClock>) =>
    withTestClock(Effect.scoped(program).pipe(Effect.provide(Layer.merge(layer, browserState.layer))));

  return { diagnostics, files, engine, lifecycle, browserState, disk, run };
};

/** A change to the store: the time Bay left, which is new every time. */
const change = (now: number) =>
  Effect.gen(function* () {
    const state = yield* BrowserState;

    yield* state.dispatch({ type: "left", now });
  });

/** Reads the saved state, as a launch does. */
const load = Effect.gen(function* () {
  const persistence = yield* Persistence;

  yield* persistence.load();
});

test("fifty changes inside the delay are written once", async () => {
  const { disk, files, run } = harness();

  await run(
    Effect.gen(function* () {
      const persistence = yield* Persistence;

      yield* persistence.start();

      for (let index = 0; index < 50; index += 1) {
        yield* TestClock.adjust(5);
        yield* change(index + 1);
      }

      yield* TestClock.adjust(SAVE_DELAY - 1);
      assert.equal(disk.writes, 0, "nothing is written while the store keeps changing");

      yield* TestClock.adjust(1);
      assert.equal(disk.writes, 1, "the burst is written once");
    }),
  );

  // SAFETY: the service wrote this file from a BrowserData, which carries both fields.
  const saved = JSON.parse(files.files.get(SAVED) ?? "null") as { version: number; leftAt: number };

  assert.equal(saved.version, 2, "browser.json stays version 2");
  assert.equal(saved.leftAt, 50, "the newest state is the one written");
  assert.equal(files.files.has(`${SAVED}.tmp`), false, "the temporary file was moved over the saved one");
});

test("a failed write is reported once and written again by the next change", async () => {
  const { disk, diagnostics, run } = harness();

  await run(
    Effect.gen(function* () {
      const persistence = yield* Persistence;

      yield* persistence.start();

      disk.failWrites = 2;
      yield* change(1);
      yield* TestClock.adjust(SAVE_DELAY);
      yield* change(2);
      yield* TestClock.adjust(SAVE_DELAY);

      assert.equal(disk.writes, 0);
      assert.equal(diagnostics.reports.length, 1, "a run of failures is reported once");
      assert.equal(diagnostics.reports[0]?.operation.name, "persistence.save");

      // Nothing retries on its own.
      yield* TestClock.adjust(SAVE_DELAY * 10);
      assert.equal(disk.writes, 0, "there is no retry loop");

      yield* change(3);
      yield* TestClock.adjust(SAVE_DELAY);
      assert.equal(disk.writes, 1, "the next change writes the dirty state");
    }),
  );
});

test("leaving the foreground writes at once, and writes a failed save again", async () => {
  const { disk, files, lifecycle, browserState, run } = harness();

  await run(
    Effect.gen(function* () {
      const persistence = yield* Persistence;

      yield* persistence.start();
      yield* TestClock.adjust(SAVE_DELAY);

      disk.failWrites = 1;
      yield* change(1);
      yield* TestClock.adjust(SAVE_DELAY);
      assert.equal(disk.writes, 0, "the write failed");

      yield* TestClock.setTime(7000);
      lifecycle.emit("background");
      assert.equal(disk.writes, 1, "leaving the foreground wrote before the native callback returned");

      // SAFETY: the service wrote this file from a BrowserData, which carries the time Bay left.
      const saved = JSON.parse(files.files.get(SAVED) ?? "null") as { leftAt: number };

      assert.equal(saved.leftAt, 7000, "the time Bay left is in the file");

      // The wait that the change started finds nothing left to write.
      yield* TestClock.adjust(SAVE_DELAY);
      assert.equal(disk.writes, 1);
    }),
  );

  assert.equal(lifecycle.handlers.length, 0, "closing the scope took the handler away");
  assert.equal(browserState.ledger.count(), 0, "and the store subscription");
});

test("nothing is written before the saved state has been read", async () => {
  const { disk, lifecycle, run } = harness();

  await run(
    Effect.gen(function* () {
      yield* change(1);
      lifecycle.emit("background");
      yield* TestClock.adjust(SAVE_DELAY);
    }),
  );

  assert.equal(disk.writes, 0);
});

test("a missing file starts fresh with a warning", async () => {
  const { diagnostics, browserState, run } = harness();

  await run(load);

  assert.equal(browserState.ready(), true);
  assert.equal(diagnostics.reports.length, 0, "a first launch is not a failure");
  assert.deepEqual(diagnostics.warnings, ["No saved browsing state; starting fresh."]);
});

test("an unreadable file starts fresh and is reported as a read failure", async () => {
  const { diagnostics, browserState, disk, run } = harness();

  disk.failReads = true;
  await run(load);

  assert.equal(browserState.ready(), true);
  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0]?.operation.name, "persistence.read");
});

test("a file that can't be decoded starts fresh and is reported as a decode failure", async () => {
  const { diagnostics, browserState, files, run } = harness();
  const before = browserState.data();

  files.files.set(SAVED, "{ not json");
  await run(load);

  assert.equal(browserState.ready(), true);
  assert.equal(browserState.data(), before, "the fresh state stays");
  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0]?.operation.name, "persistence.decode");
});

test("a saved file is read back into the store", async () => {
  const { browserState, files, run } = harness();
  const saved = initialBrowserData(createTab("saved-tab", Date.now(), "https://bay.example/"));

  files.files.set(SAVED, JSON.stringify({ version: 2, ...saved }));
  await run(load);

  assert.equal(browserState.ready(), true);
  assert.deepEqual(
    browserState.data().tabs.map((tab) => tab.url),
    ["https://bay.example/"],
  );
});

test("tab changes prune once per quiet period, and a private tab's state is never kept", async () => {
  const { engine, run } = harness();

  await run(
    Effect.gen(function* () {
      const persistence = yield* Persistence;
      const state = yield* BrowserState;

      yield* persistence.start();
      yield* TestClock.adjust(PRUNE_DELAY);
      assert.equal(engine.prunedSnapshots.length, 1, "the launch prunes once");

      for (let index = 0; index < 5; index += 1) {
        yield* state.dispatch({ type: "new-tab", tab: createTab(`tab-${index}`, 0, "https://bay.example/", index === 4), background: true });
        yield* TestClock.adjust(1000);
      }

      assert.equal(engine.prunedSnapshots.length, 1, "nothing is pruned while the tabs keep changing");

      yield* TestClock.adjust(PRUNE_DELAY);
      assert.equal(engine.prunedSnapshots.length, 2, "the burst prunes once");
      assert.equal(engine.prunedTabStates.length, 2);

      const kept = engine.prunedTabStates[1] ?? [];

      assert.ok(kept.includes("tab-0"));
      assert.ok(!kept.includes("tab-4"), "the private tab's saved state is not kept");
    }),
  );
});
