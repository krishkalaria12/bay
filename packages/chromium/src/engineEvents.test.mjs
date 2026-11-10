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

const { onDownload, onPermission, onPermissionDismissed } = await import("./nativeModule.ts");

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

// The web host lists what a listener missed before it subscribed (BayCEF.listDownloads).
const cef = globalThis.nnTestNativeModules.BayCEF;

const listing = () => {
  let resolve, reject;
  cef.listDownloads = () => new Promise((yes, no) => ((resolve = yes), (reject = no)));

  return { resolve: (list) => resolve(list), reject: (error) => reject(error) };
};

const settle = () => new Promise((done) => setTimeout(done, 0));

test("a host's download list reaches a new listener, unless an event already reported that download", async (t) => {
  t.after(() => delete cef.listDownloads);
  const list = listing();
  const seen = [];
  const subscription = onDownload((d) => seen.push(`${d.id}:${d.state}`));
  fire("onDownload", { id: "d1", state: "finished" });
  list.resolve([
    { id: "d1", state: "downloading" },
    { id: "d2", state: "finished" },
  ]);
  await settle();
  fire("onDownload", { id: "d2", state: "finished" });
  subscription.remove();
  assert.deepEqual(seen, ["d1:finished", "d2:finished", "d2:finished"]);
});

test("a removed listener gets no download list, and a failed list is quiet", async (t) => {
  t.after(() => delete cef.listDownloads);
  const removed = listing();
  const seen = [];
  onDownload((d) => seen.push(d.id)).remove();
  removed.resolve([{ id: "d1" }]);
  await settle();
  const failed = listing();
  const subscription = onDownload((d) => seen.push(d.id));
  failed.reject(new Error("host went away"));
  await settle();
  fire("onDownload", { id: "d2" });
  subscription.remove();
  assert.deepEqual(seen, ["d2"]);
});

test("a host without a download list leaves listeners to events", () => {
  assert.equal(cef.listDownloads, undefined);
  assert.deepEqual(received(onDownload, "onDownload", ["d3"]), ["d3"]);
});
