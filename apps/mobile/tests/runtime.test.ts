// The app's runtime (src/effect/runtime.ts): one per JavaScript instance, shared by every screen, and giving back
// everything it owns when it is disposed.
import assert from "node:assert/strict";
import test from "node:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";

import { readCommandExit } from "../src/effect/commands.ts";
import { BrowserState } from "../src/effect/ports/browserState.ts";
import { Engine } from "../src/effect/ports/engine.ts";
import { HttpError } from "../src/effect/ports/http.ts";
import { Lifecycle } from "../src/effect/ports/lifecycle.ts";
import { Links } from "../src/effect/ports/links.ts";
import { fakeBrowserState, fakeDiagnostics, fakeEngine, fakeLifecycle, fakeLinks, ResourceLedger } from "../src/effect/testing.ts";

test("a runtime that is disposed gives back everything it was holding", async () => {
  const ledger = new ResourceLedger();
  const diagnostics = fakeDiagnostics();
  const lifecycle = fakeLifecycle(ledger);
  const links = fakeLinks(ledger);
  const engine = fakeEngine(ledger);
  const browserState = fakeBrowserState(ledger);

  const layer = Layer.mergeAll(diagnostics.layer, lifecycle.layer, links.layer, engine.layer, browserState.layer);
  const runtime = ManagedRuntime.make(layer, { memoMap: Layer.makeMemoMapUnsafe() });

  await runtime.runPromise(
    Scope.provide(runtime.scope)(
      Effect.gen(function* () {
        const lifecycleService = yield* Lifecycle;
        const linksService = yield* Links;
        const engineService = yield* Engine;
        const browserStateService = yield* BrowserState;

        yield* lifecycleService.onChange(() => undefined);
        yield* linksService.onLink(() => undefined);
        yield* linksService.onShare(() => undefined);
        yield* engineService.onDownload(() => undefined);
        yield* browserStateService.subscribe(() => undefined);
      }),
    ),
  );

  assert.equal(ledger.count(), 5, "the listeners are held while the runtime is alive");

  // A timer the runtime owns: it is interrupted when the runtime is disposed.
  ledger.take("timer");

  const timer = runtime.runFork(Effect.never);
  const finished = Effect.runPromise(Fiber.await(timer)).then(() => ledger.give("timer"));

  await runtime.dispose();
  await finished;

  assert.equal(ledger.count(), 0, "the runtime gave back everything it was holding");
  assert.deepEqual(ledger.outstanding(), []);
});

test("a typed failure is reported once, and the runtime keeps serving", async () => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(diagnostics.layer, { memoMap: Layer.makeMemoMapUnsafe() });

  const failure = new HttpError({ operation: { name: "http.send", resource: "https://bay.example" }, status: 500, cause: new Error("the server said no") });

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.fail(failure));

      return yield* readCommandExit({ name: "test" }, exit);
    }),
  );

  assert.equal(result._tag, "Failed");
  assert.equal(diagnostics.reports.length, 1, "the failure is reported once");
  assert.equal(diagnostics.reports[0]?.cause, failure);

  const after = await runtime.runPromise(Effect.succeed("still here"));

  assert.equal(after, "still here");
  assert.equal(diagnostics.reports.length, 1, "the runtime is still serving, and the failure is not reported twice");

  await runtime.dispose();
});

test("an interrupted sleep ends without reporting", async () => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(diagnostics.layer, { memoMap: Layer.makeMemoMapUnsafe() });

  const sleeping = runtime.runFork(Effect.sleep("1 hour"));

  await Effect.runPromise(Fiber.interrupt(sleeping));

  const exit = await Effect.runPromise(Fiber.await(sleeping));

  assert.ok(Cause.hasInterruptsOnly(exit.cause), "the sleep was interrupted, not failed");

  const result = await runtime.runPromise(readCommandExit({ name: "test" }, exit));

  assert.equal(result._tag, "Cancelled");
  assert.equal(diagnostics.reports.length, 0, "cancelled work is not a failure");

  await runtime.dispose();
});
