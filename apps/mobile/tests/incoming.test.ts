// Links from other apps (src/browser/incoming.ts): one that arrives before the tabs load waits for them, one that
// arrives after opens at once, and only the newest one waits.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { IncomingLinks } from "../src/browser/incoming.ts";
import { fakeBrowserState, fakeDiagnostics, fakeLinks, ResourceLedger } from "../src/effect/testing.ts";

/** Lets forked work run until it waits again: a few turns of the event loop, so a busy machine gets there too. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).pipe(Effect.repeat({ times: 10 }));

const setup = () => {
  const ledger = new ResourceLedger();
  const links = fakeLinks(ledger);
  const browserState = fakeBrowserState(ledger);
  const layer = IncomingLinks.layer.pipe(Layer.provide(Layer.mergeAll(links.layer, browserState.layer, fakeDiagnostics().layer)));

  return { ledger, links, browserState, layer };
};

test("a link before the tabs load waits for them, and only the newest one waits", async () => {
  const { ledger, links, browserState, layer } = setup();
  const opened: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const incoming = yield* IncomingLinks;

      yield* Scope.provide(scope)(incoming.start);

      const screen = yield* Effect.forkChild(incoming.receive((url) => opened.push(url)));

      yield* settle;

      links.emitLink("https://first.example/");
      links.emitShare("https://second.example/");

      assert.deepEqual(opened, [], "nothing opens before the tabs are loaded");

      browserState.markReady();
      yield* settle;

      assert.deepEqual(opened, ["https://second.example/"], "the newest link opens once the tabs are there");

      yield* Fiber.interrupt(screen);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer)),
  );

  assert.equal(ledger.count(), 0, "closing the scope removes the listeners");
});

test("after the tabs load, a link opens the moment it arrives", async () => {
  const { links, browserState, layer } = setup();
  const opened: string[] = [];

  browserState.markReady();

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const incoming = yield* IncomingLinks;

      yield* Scope.provide(scope)(incoming.start);

      const screen = yield* Effect.forkChild(incoming.receive((url) => opened.push(url)));

      yield* settle;

      links.emitLink("bay://new-tab");

      assert.deepEqual(opened, ["bay://new-tab"], "handed over within the native callback");

      yield* Fiber.interrupt(screen);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer)),
  );
});

test("a link waits for the screen to listen, and a screen that stopped listening gets nothing", async () => {
  const { links, browserState, layer } = setup();
  const opened: string[] = [];

  browserState.markReady();

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const incoming = yield* IncomingLinks;

      yield* Scope.provide(scope)(incoming.start);
      yield* settle;

      links.emitLink("https://waiting.example/");

      const screen = yield* Effect.forkChild(incoming.receive((url) => opened.push(url)));

      yield* settle;

      assert.deepEqual(opened, ["https://waiting.example/"]);

      yield* Fiber.interrupt(screen);

      links.emitLink("https://later.example/");

      assert.deepEqual(opened, ["https://waiting.example/"], "a screen that is gone is not handed links");

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer)),
  );
});
