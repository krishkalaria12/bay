import assert from "node:assert/strict";
import { test } from "node:test";
import { startSharedRuntime, prepareCoordinatorStore } from "./startup.ts";
import { createBrowserStore } from "../store/browser.ts";
import { createBrowserProjector } from "./projection.ts";

test("browser-assigned window startup never invokes coordinator services", async () => {
  const calls = [];
  const transport = {
    bootstrap: { role: "window", windowId: "window-1" },
    dispose() {
      calls.push("dispose");
    },
  };
  const owner = { dispose() {} };
  assert.equal(
    await startSharedRuntime({
      transport,
      coordinator: async () => {
        throw new Error("second writer");
      },
      window: async (received) => {
        assert.equal(received, transport);
        calls.push("window");
        return owner;
      },
    }),
    owner,
  );
  assert.deepEqual(calls, ["window"]);
});

test("failed shared startup disposes its connection without starting a local writer", async () => {
  const calls = [];
  const transport = {
    bootstrap: { role: "coordinator" },
    dispose() {
      calls.push("dispose");
    },
  };
  await assert.rejects(
    startSharedRuntime({
      transport,
      coordinator: async () => {
        calls.push("coordinator");
        throw new Error("recovery rejected");
      },
      window: async () => {
        calls.push("window");
      },
    }),
    /recovery rejected/,
  );
  assert.deepEqual(calls, ["coordinator", "dispose"]);
});

test("new coordinator restores disk before creating its initial window", () => {
  const store = createBrowserStore();
  const restored = [];
  prepareCoordinatorStore(store, undefined, (target) => {
    restored.push(target);
    target.getState().createWindow({ url: "https://restored.test" });
  });
  assert.deepEqual(restored, [store]);
  assert.equal(store.getState().windowOrder.length, 1);
  assert.equal(Object.values(store.getState().tabs)[0].url, "https://restored.test");
});

test("coordinator recovery skips disk hydration and initial-window creation", () => {
  const original = createBrowserStore();
  original.getState().createWindow();
  const recovery = createBrowserProjector()(original.getState());
  const store = createBrowserStore();
  prepareCoordinatorStore(store, recovery, () => {
    throw new Error("disk state must not overwrite accepted state");
  });
  assert.equal(store.getState().windowOrder.length, 0);
});
