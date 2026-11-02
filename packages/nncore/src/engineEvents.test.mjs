import assert from "node:assert/strict";
import { test } from "node:test";
import "../../../apps/browser/src/test-loader.mjs";

// The legacy architecture's module events reach every module's listeners for that name: both modules here hear each
// event, as the app's do (a Chromium prompt came back after it was answered).
const listeners = new Map();
const addListener = (name, listener) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(listener);
  return { remove: () => listeners.get(name).delete(listener) };
};
const fire = (name, value) => [...(listeners.get(name) ?? [])].forEach((listener) => listener(value));
globalThis.nnTestNativeModules = { BayCEF: { addListener }, BayWebKit: { addListener } };

const { onDownload, onPermission, onPermissionDismissed } = await import("./module.ts");

const received = (subscribe, name, ids) => {
  const seen = [];
  const subscription = subscribe((value) => seen.push(value.id));
  for (const id of ids) fire(name, { id });
  subscription.remove();
  for (const id of ids) fire(name, { id });
  return seen;
};

test("each engine's permission prompt reaches the app once", () => {
  assert.deepEqual(received(onPermission, "onPermission", ["p1", "wk-permission-1"]), ["p1", "wk-permission-1"]);
});

test("each engine's dismissed prompt reaches the app once", () => {
  assert.deepEqual(received(onPermissionDismissed, "onPermissionDismissed", ["p1", "wk-permission-1"]), ["p1", "wk-permission-1"]);
});

test("each engine's download reaches the app once", () => {
  assert.deepEqual(received(onDownload, "onDownload", ["d1", "wk-download-1"]), ["d1", "wk-download-1"]);
});
