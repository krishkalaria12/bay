// The private session (src/browser/privateSession.ts): native is told at launch, then follows the tabs one call at a
// time, in order, with only the newest wish sent.
import assert from "node:assert/strict";
import test from "node:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { PrivateSession } from "../src/browser/privateSession.ts";
import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Engine } from "../src/effect/ports/engine.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, ResourceLedger } from "../src/effect/testing.ts";
import { createTab } from "../src/store/model.ts";

/** An engine whose private-session calls are recorded, and held until the test lets each one finish. */
const slowEngine = () => {
  const calls: boolean[] = [];
  const pending: Deferred.Deferred<void>[] = [];

  const base = Effect.runSync(
    Effect.provide(
      Engine.useSync((engine) => engine),
      fakeEngine().layer,
    ),
  );

  return {
    layer: Layer.succeed(Engine)({
      ...base,
      setPrivateSessionActive: (active) =>
        Effect.gen(function* () {
          calls.push(active);

          const done = yield* Deferred.make<void>();

          pending.push(done);
          yield* Deferred.await(done);
        }),
    }),
    calls,
    /** Lets every call that is waiting finish. */
    finish: () => Effect.forEach(pending.splice(0), (done) => Deferred.succeed(done, undefined), { discard: true }),
  };
};

/** Lets the forked worker run until it waits again: a few turns of the event loop, so a busy machine gets there too. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).pipe(Effect.repeat({ times: 10 }));

test("quick toggles reach native in order and end on the last value", async () => {
  const ledger = new ResourceLedger();
  const engine = slowEngine();
  const browserState = fakeBrowserState(ledger);
  const layer = PrivateSession.layer.pipe(Layer.provideMerge(Layer.mergeAll(engine.layer, browserState.layer, fakeDiagnostics().layer)));

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* PrivateSession;
      const state = yield* BrowserState;

      yield* Scope.provide(scope)(session.start);
      yield* settle;

      assert.deepEqual(engine.calls, [false], "native is told once at launch");

      yield* engine.finish();
      yield* settle;

      // A private tab opens: native hears about it, and holds on to the call.
      yield* state.dispatch({ type: "new-tab", tab: createTab("private-1", 1, "https://a.example", true), background: false });
      yield* settle;

      assert.deepEqual(engine.calls, [false, true]);

      // While that call is out, the tab closes, another opens and closes again.
      yield* state.dispatch({ type: "close-tab", id: "private-1", now: 2, fallback: createTab("blank-1", 2) });
      yield* state.dispatch({ type: "new-tab", tab: createTab("private-2", 3, "https://b.example", true), background: false });
      yield* state.dispatch({ type: "close-tab", id: "private-2", now: 4, fallback: createTab("blank-2", 4) });

      assert.deepEqual(engine.calls, [false, true], "nothing more is sent while a call is out");

      yield* engine.finish();
      yield* settle;
      yield* engine.finish();
      yield* settle;

      assert.deepEqual(engine.calls, [false, true, false], "the session ends once, after the last change");

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer)),
  );

  assert.equal(ledger.count(), 0, "closing the scope lets go of the store subscription");
});
