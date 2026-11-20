// Scoped work (src/effect/react.ts, useScopedWork): work that belongs to a key, interrupted when the key changes or
// the component goes. A component is rendered with react-dom into jsdom, so the hook runs as it does in the app.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { useScopedWork, type Command } from "../src/effect/react.ts";
import { disposeMobileRuntime } from "../src/effect/runtime.ts";

const dom = new JSDOM("<!doctype html><div id='root'></div>");

// React reads these globals while it renders into a document, and warns about updates outside `act` without the flag.
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

after(() => disposeMobileRuntime());

/** The hook as the last render saw it. */
type Probe = { work: Command<string> | null };

function Worker({ name, probe }: { name: string; probe: Probe }) {
  probe.work = useScopedWork<string>(name);

  return null;
}

/** Renders the worker under a key, or again under a new one. */
const render = (root: Root, name: string, probe: Probe) =>
  act(() => {
    root.render(createElement(Worker, { name, probe }));
  });

/** Lets the runtime finish what it was doing: closing scopes and reading answers. */
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const container = () => dom.window.document.createElement("div");

test("a result that arrives after the key changes is dropped", async () => {
  const root = createRoot(container());
  const probe: Probe = { work: null };
  const gate = Effect.runSync(Deferred.make<string>());
  const landed: string[] = [];

  await render(root, "page one", probe);
  probe.work?.run(Effect.tap(Deferred.await(gate), (answer) => Effect.sync(() => landed.push(answer))));
  await settle();

  // The page changes while the answer is still on its way.
  await render(root, "page two", probe);
  await settle();
  Effect.runSync(Deferred.succeed(gate, "late"));
  await settle();

  assert.deepEqual(landed, [], "the late answer never ran its continuation");
  assert.equal(probe.work?.result, null, "and never reached the component");

  probe.work?.run(Effect.succeed("fresh"));
  await settle();

  assert.deepEqual(probe.work?.result, { _tag: "Done", value: "fresh" }, "work under the new key still answers");

  await act(() => root.unmount());
});

test("a scope's finalizers run once, when its key goes", async () => {
  const root = createRoot(container());
  const probe: Probe = { work: null };
  let closed = 0;

  await render(root, "page one", probe);
  probe.work?.run(
    Effect.as(
      Effect.addFinalizer(() => Effect.sync(() => (closed += 1))),
      "opened",
    ),
  );
  probe.work?.run(Effect.succeed("again"));
  await settle();

  assert.equal(closed, 0, "the finalizer waits for the scope, not for the program");

  await render(root, "page two", probe);
  await settle();
  await render(root, "page three", probe);
  await settle();
  await act(() => root.unmount());
  await settle();

  assert.equal(closed, 1);
});

test("unmounting interrupts the work", async () => {
  const root = createRoot(container());
  const probe: Probe = { work: null };
  let interrupted = false;

  await render(root, "page", probe);
  probe.work?.run(
    Effect.onInterrupt(Effect.never, () =>
      Effect.sync(() => {
        interrupted = true;
      }),
    ),
  );
  await settle();
  await act(() => root.unmount());
  await settle();

  assert.ok(interrupted);
});
