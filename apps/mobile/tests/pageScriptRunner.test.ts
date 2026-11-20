// The page-script runner (src/browser/pageScripts.ts) over the engine port: a page that never answers fails after ten
// seconds with a typed error, an answer of the wrong shape is a decode failure, and the quiet form drops what a page
// is expected to do wrong but not a defect.
import assert from "node:assert/strict";
import test from "node:test";
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as v from "valibot";

import { pageScriptFailure, quietly, read, run } from "../src/browser/pageScripts.ts";
import { Engine, PAGE_SCRIPT_TIMEOUT } from "../src/effect/ports/engine.ts";
import { fakeDiagnostics, withTestClock } from "../src/effect/testing.ts";

/** A page view whose page answers every script with `evaluate`. */
const fakeView = (evaluate: (script: string) => Promise<string>): Tab => ({
  load: () => Promise.resolve(),
  goBack: () => Promise.resolve(),
  goForward: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  snapshot: () => Promise.resolve(null),
  saveState: () => Promise.resolve(),
  answerPageRequest: () => Promise.resolve(),
  evaluate,
});

// The real engine port: its page scripts run on the view alone, so nothing native is loaded.
const engine = Engine.layer.pipe(Layer.provide(fakeDiagnostics().layer));

test("a page that never answers fails after ten seconds with a typed error", async () => {
  const silent = fakeView(() => new Promise<string>(() => undefined));

  const exit = await withTestClock(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(run<string>(silent, "return 1")));

      yield* TestClock.adjust(PAGE_SCRIPT_TIMEOUT - 1);
      yield* Effect.yieldNow;

      assert.equal(fiber.pollUnsafe(), undefined, "still waiting just before the limit");

      yield* TestClock.adjust(1);

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(engine)),
  );

  assert.ok(Exit.isFailure(exit));

  const failure = Exit.findErrorOption(exit);

  assert.equal(failure._tag === "Some" ? failure.value._tag : null, "PageScriptTimeout");
  assert.equal(failure._tag === "Some" ? pageScriptFailure(failure.value).message : null, "The page didn't answer.");
});

test("an answer of the wrong shape is a decode failure", async () => {
  const view = fakeView(() => Promise.resolve(JSON.stringify({ count: "many" })));

  const exit = await Effect.runPromise(Effect.exit(read(view, "return 1", v.object({ count: v.number() }))).pipe(Effect.provide(engine)));
  const failure = Exit.findErrorOption(exit);

  assert.equal(failure._tag === "Some" ? failure.value._tag : null, "DecodeError");
});

test("the quiet form drops a page's failure and keeps a defect", async () => {
  const broken = fakeView(() => Promise.reject(new Error("the page went away")));

  const dropped = await Effect.runPromise(Effect.exit(quietly(run(broken, "return 1"))).pipe(Effect.provide(engine)));

  assert.ok(Exit.isSuccess(dropped));

  const defect = await Effect.runPromise(Effect.exit(quietly(Effect.die(new Error("a bug")))));

  assert.ok(Exit.isFailure(defect), "a defect is not a page's failure");
});
