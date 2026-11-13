// Tab snapshots (src/browser/snapshots.ts): one pending picture per tab, a moment after each visit, never for a
// closed tab, a private tab or a page that failed.
import assert from "node:assert/strict";
import test from "node:test";
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { SNAPSHOT_DELAY_MS, Snapshots } from "../src/browser/snapshots.ts";
import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Engine } from "../src/effect/ports/engine.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, withTestClock } from "../src/effect/testing.ts";
import { createTab } from "../src/store/model.ts";

/** A page view that does nothing: the fake engine takes its pictures. */
const fakeView = (): Tab => ({
  load: () => Promise.resolve(),
  goBack: () => Promise.resolve(),
  goForward: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  snapshot: () => Promise.resolve(null),
  saveState: () => Promise.resolve(),
  answerPageRequest: () => Promise.resolve(),
  evaluate: () => Promise.resolve("null"),
});

/** A service over fakes, with an engine that remembers which view each picture was taken of. */
const setup = () => {
  const pictured: Tab[] = [];
  const browserState = fakeBrowserState();
  const diagnostics = fakeDiagnostics();

  const engine = Layer.effect(
    Engine,
    Effect.gen(function* () {
      const base = yield* Engine;

      return Engine.of({
        ...base,
        snapshot: (view) =>
          Effect.sync(() => {
            pictured.push(view);

            return `file:///cache/snapshot-${pictured.length}.jpg`;
          }),
      });
    }),
  ).pipe(Layer.provide(fakeEngine().layer));

  const layer = Snapshots.layer.pipe(Layer.provideMerge(Layer.mergeAll(engine, browserState.layer, diagnostics.layer)));

  return { pictured, browserState, diagnostics, layer };
};

const notFailed = () => false;

/** Moves the test clock past the snapshot delay and lets the woken captures finish. */
const afterDelay = Effect.gen(function* () {
  yield* TestClock.adjust(SNAPSHOT_DELAY_MS);
  yield* Effect.yieldNow;
});

test("the newest visit replaces the picture a tab was waiting for", async () => {
  const { pictured, browserState, diagnostics, layer } = setup();
  const first = fakeView();
  const second = fakeView();

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const snapshots = yield* Snapshots;

        yield* snapshots.start;
        yield* snapshots.visited("tab-1", first, notFailed);
        yield* TestClock.adjust(SNAPSHOT_DELAY_MS / 2);
        yield* snapshots.visited("tab-1", second, notFailed);
        yield* TestClock.adjust(SNAPSHOT_DELAY_MS / 2);
        yield* Effect.yieldNow;

        assert.equal(pictured.length, 0, "the replaced visit's picture was never taken");

        yield* afterDelay;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.deepEqual(pictured, [second], "only the newest visit is pictured");
  assert.equal(browserState.data().tabs[0]?.snapshot, "file:///cache/snapshot-1.jpg");
  assert.equal(diagnostics.reports.length, 0);
});

test("a tab that closes before its picture gets none", async () => {
  const { pictured, browserState, layer } = setup();
  const view = fakeView();

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const snapshots = yield* Snapshots;
        const state = yield* BrowserState;

        yield* snapshots.start;
        yield* state.dispatch({ type: "new-tab", tab: createTab("tab-2", 1, "https://bay.example"), background: false });
        yield* snapshots.visited("tab-2", view, notFailed);
        yield* state.dispatch({ type: "close-tab", id: "tab-2", now: 2, fallback: createTab("tab-3", 2) });
        // A tab under the same id before the delay ends: a capture that was only skipped at the end would picture it.
        yield* state.dispatch({ type: "new-tab", tab: createTab("tab-2", 3, "https://bay.example/again"), background: true });
        yield* afterDelay;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(pictured.length, 0, "closing the tab interrupted the capture it was waiting for");
  assert.equal(browserState.data().tabs.find((tab) => tab.id === "tab-2")?.snapshot, null);
});

test("a private tab and a failed page leave no picture", async () => {
  const { pictured, browserState, layer } = setup();

  await withTestClock(
    Effect.scoped(
      Effect.gen(function* () {
        const snapshots = yield* Snapshots;
        const state = yield* BrowserState;

        yield* snapshots.start;
        yield* state.dispatch({ type: "new-tab", tab: createTab("private-1", 1, "https://bay.example", true), background: true });
        yield* snapshots.visited("private-1", fakeView(), notFailed);
        yield* snapshots.capture("private-1", fakeView(), notFailed);
        yield* snapshots.visited("tab-1", fakeView(), () => true);
        yield* snapshots.capture("tab-1", fakeView(), () => true);
        yield* afterDelay;
      }),
    ).pipe(Effect.provide(layer)),
  );

  assert.equal(pictured.length, 0);
  assert.ok(browserState.data().tabs.every((tab) => tab.snapshot === null));
});

test("a capture for the switcher is taken at once", async () => {
  const { pictured, layer } = setup();
  const view = fakeView();

  await withTestClock(
    Effect.gen(function* () {
      const snapshots = yield* Snapshots;

      yield* snapshots.capture("tab-1", view, notFailed);
    }).pipe(Effect.provide(layer)),
  );

  assert.deepEqual(pictured, [view]);
});
