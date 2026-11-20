// Clearing browsing data (src/browser/clearData.ts): the tabs' work stops before anything is reset, the engine clears
// only once the page views have gone or a second has passed, and once it starts it isn't interrupted.
import assert from "node:assert/strict";
import test from "node:test";
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ClearData, VIEWS_GONE_MS, ViewRegistry } from "../src/browser/clearData.ts";
import { TabWork } from "../src/browser/tabWork.ts";
import { Engine } from "../src/effect/ports/engine.ts";
import { fakeBrowserState, fakeEngine, withTestClock } from "../src/effect/testing.ts";

/** A page view that does nothing. */
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

/** The service over fakes, with an engine whose clear takes `clearMs` and writes down when it starts and ends. */
const setup = (clearMs = 0) => {
  const events: string[] = [];

  const engine = Layer.effect(
    Engine,
    Effect.gen(function* () {
      const base = yield* Engine;

      return Engine.of({
        ...base,
        clearData: () =>
          Effect.gen(function* () {
            events.push("clearing");

            if (clearMs) yield* Effect.sleep(clearMs);
            events.push("cleared");
          }),
      });
    }),
  ).pipe(Layer.provide(fakeEngine().layer));

  const tabWork = TabWork.layer.pipe(Layer.provide(fakeBrowserState().layer));
  const layer = ClearData.layer.pipe(Layer.provideMerge(Layer.mergeAll(tabWork, engine)));

  return { events, layer };
};

/** Lets the woken fibers run. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 5; turn++) yield* Effect.yieldNow;
});

test("the tabs' work is interrupted before the reset and the native clear", async () => {
  const { events, layer } = setup();
  const views = new ViewRegistry();

  await withTestClock(
    Effect.gen(function* () {
      const tabWork = yield* TabWork;
      const clearData = yield* ClearData;

      yield* tabWork.run("tab-1", "logins.signIn 1", Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void events.push("sign-in stopped")))));
      yield* tabWork.run("tab-2", "snapshot", Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void events.push("snapshot stopped")))));
      yield* clearData.clear({ reset: () => void events.push("reset"), views });
    }).pipe(Effect.provide(layer)),
  );

  assert.deepEqual(events, ["sign-in stopped", "snapshot stopped", "reset", "clearing", "cleared"]);
});

test("the native clear waits for the page views to go", async () => {
  const { events, layer } = setup();
  const views = new ViewRegistry();

  views.set("tab-1", fakeView());
  views.set("tab-2", fakeView());

  await withTestClock(
    Effect.gen(function* () {
      const clearData = yield* ClearData;
      const wipe = yield* Effect.forkChild(clearData.clear({ reset: () => void events.push("reset"), views }));

      yield* settle;
      views.delete("tab-1");
      yield* TestClock.adjust(100);
      yield* settle;

      assert.deepEqual(events, ["reset"], "a view is still on screen");

      views.delete("tab-2");
      yield* settle;

      assert.deepEqual(events, ["reset", "clearing", "cleared"], "the last view went, well before the cap");

      yield* Fiber.join(wipe);
    }).pipe(Effect.provide(layer)),
  );
});

test("a view that never goes holds the clear up for a second at most", async () => {
  const { events, layer } = setup();
  const views = new ViewRegistry();

  views.set("tab-1", fakeView());

  await withTestClock(
    Effect.gen(function* () {
      const clearData = yield* ClearData;
      const wipe = yield* Effect.forkChild(clearData.clear({ reset: () => void events.push("reset"), views }));

      yield* settle;
      yield* TestClock.adjust(VIEWS_GONE_MS - 1);
      yield* settle;

      assert.deepEqual(events, ["reset"]);

      yield* TestClock.adjust(1);
      yield* settle;

      assert.deepEqual(events, ["reset", "clearing", "cleared"]);

      yield* Fiber.join(wipe);
    }).pipe(Effect.provide(layer)),
  );
});

test("the native clear isn't interrupted once it has started", async () => {
  const { events, layer } = setup(5_000);
  const views = new ViewRegistry();

  await withTestClock(
    Effect.gen(function* () {
      const clearData = yield* ClearData;
      const wipe = yield* Effect.forkChild(clearData.clear({ reset: () => void events.push("reset"), views }));

      yield* settle;

      assert.deepEqual(events, ["reset", "clearing"]);

      // Interrupting waits for the clear, which still runs to its end.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(wipe));

      yield* TestClock.adjust(5_000);
      yield* Fiber.join(interrupting);

      assert.deepEqual(events, ["reset", "clearing", "cleared"]);
    }).pipe(Effect.provide(layer)),
  );
});

test("ending a tab's page stops its work and leaves the other tabs' alone", async () => {
  const stopped: string[] = [];
  const layer = TabWork.layer.pipe(Layer.provide(fakeBrowserState().layer));

  await withTestClock(
    Effect.gen(function* () {
      const tabWork = yield* TabWork;
      const track = (name: string) => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void stopped.push(name))));

      yield* tabWork.run("tab-1", "snapshot", track("first snapshot"));
      yield* tabWork.run("tab-1", "snapshot", track("second snapshot"));
      yield* settle;

      assert.deepEqual(stopped, ["first snapshot"], "a newer run under the same name replaces the older one");

      const other = yield* tabWork.run("tab-2", "logins.signIn 1", track("other tab"));

      yield* tabWork.end("tab-1");

      assert.deepEqual(stopped, ["first snapshot", "second snapshot"]);
      assert.equal(other.pollUnsafe(), undefined, "the other tab's work is still running");

      yield* tabWork.endAll;

      assert.deepEqual(stopped, ["first snapshot", "second snapshot", "other tab"]);
    }).pipe(Effect.provide(layer)),
  );
});
