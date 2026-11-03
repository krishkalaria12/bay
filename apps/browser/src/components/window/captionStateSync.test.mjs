import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { captionState, emitWindowEvent, windowEventListeners } from "../../test-native-stub.mjs";
import { startCaptionStateSync } from "./captionStateSync.ts";

let resolveQuery;
beforeEach(() => {
  windowEventListeners.clear();
  captionState.query = (id) => {
    assert.equal(id, "caption");
    assert.equal(windowEventListeners.size, 1, "subscribe before querying");
    return new Promise((resolve) => (resolveQuery = resolve));
  };
});

const stateEvent = (state, id = "caption") => emitWindowEvent({ type: "state", id, ...state });
const restored = { maximized: false, fullscreen: false };

test("bootstrap state is used when no matching event arrives", async (t) => {
  const values = [];
  t.after(startCaptionStateSync("caption", (state) => values.push(state)));
  resolveQuery(restored);
  await Promise.resolve();
  assert.deepEqual(values, [restored]);
  stateEvent({ maximized: true, fullscreen: false });
  assert.deepEqual(values.at(-1), { maximized: true, fullscreen: false });
});

for (const state of [
  { maximized: true, fullscreen: false },
  { maximized: false, fullscreen: true },
]) {
  test(`a delayed restored query cannot overwrite ${state.fullscreen ? "fullscreen" : "maximized"} state`, async (t) => {
    const values = [];
    t.after(startCaptionStateSync("caption", (state) => values.push(state)));
    stateEvent(state);
    resolveQuery(restored);
    await Promise.resolve();
    assert.deepEqual(values, [state]);
    stateEvent(restored);
    assert.deepEqual(values, [state, restored]);
  });
}

test("events for other windows and unrelated events do not suppress bootstrap", async (t) => {
  const values = [];
  t.after(startCaptionStateSync("caption", (state) => values.push(state)));
  stateEvent({ maximized: true, fullscreen: true }, "other");
  emitWindowEvent({ type: "focused", id: "caption" });
  resolveQuery(restored);
  await Promise.resolve();
  assert.deepEqual(values, [restored]);
});

test("teardown removes the listener and ignores the old window's pending reply", async () => {
  const values = [];
  const stop = startCaptionStateSync("caption", (state) => values.push(state));
  const oldListener = [...windowEventListeners][0];
  stop();
  stop();
  assert.equal(windowEventListeners.size, 0);
  oldListener({ type: "state", id: "caption", maximized: true, fullscreen: true });
  resolveQuery(restored);
  await Promise.resolve();
  assert.deepEqual(values, []);
});

test("a failed query leaves the event subscription working", async (t) => {
  captionState.query = () => Promise.reject(new Error("gone"));
  const values = [];
  t.after(startCaptionStateSync("caption", (state) => values.push(state)));
  await Promise.resolve();
  stateEvent(restored);
  assert.deepEqual(values, [restored]);
});
