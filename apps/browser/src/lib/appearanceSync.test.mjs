import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { appearanceState, appEventListeners, emitAppEvent } from "../test-native-stub.mjs";
import { startAppearanceSync } from "./appearanceSync.ts";

let resolveQuery;
beforeEach(() => {
  appEventListeners.clear();
  appearanceState.query = () => new Promise((resolve) => (resolveQuery = resolve));
});

test("the bootstrap query supplies appearance when no event has arrived", async (t) => {
  const values = [];
  t.after(startAppearanceSync((dark) => values.push(dark)));
  resolveQuery(true);
  await Promise.resolve();
  assert.deepEqual(values, [true]);
  emitAppEvent({ type: "appearance", dark: false });
  assert.deepEqual(values, [true, false]);
});

test("a delayed query cannot overwrite a newer appearance event", async (t) => {
  const values = [];
  t.after(startAppearanceSync((dark) => values.push(dark)));
  emitAppEvent({ type: "appearance", dark: true });
  resolveQuery(false);
  await Promise.resolve();
  assert.deepEqual(values, [true]);
  emitAppEvent({ type: "appearance", dark: false });
  assert.deepEqual(values, [true, false]);
});

test("unrelated app events do not suppress the bootstrap query", async (t) => {
  const values = [];
  t.after(startAppearanceSync((dark) => values.push(dark)));
  emitAppEvent({ type: "reopen" });
  resolveQuery(true);
  await Promise.resolve();
  assert.deepEqual(values, [true]);
});

test("teardown ignores a pending query and removes the appearance listener", async () => {
  const values = [];
  const stop = startAppearanceSync((dark) => values.push(dark));
  assert.equal(appEventListeners.size, 1);
  stop();
  stop();
  resolveQuery(true);
  await Promise.resolve();
  emitAppEvent({ type: "appearance", dark: false });
  assert.deepEqual(values, []);
  assert.equal(appEventListeners.size, 0);
});
