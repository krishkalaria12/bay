import assert from "node:assert/strict";
import { test } from "node:test";
import "../../../apps/browser/src/test-loader.mjs";

const calls = [];
let saved = "/downloads/Bay Trace test.json";
let recording = false;
let rejectWindow = false;

globalThis.nnTestNativeModules = {
  BayCEF: {
    chromeWindows: async () => [{ window: 12, appWindow: "work", profile: "", visible: true }],
    devWindowNumber: async (tab) => (tab === 42 ? 12 : 0),
    devWindow: async (id, action) => {
      calls.push([id, action]);

      if (rejectWindow) throw Object.assign(new Error("unsupported action"), { code: "unsupported_action" });

      return '{"visible":true}';
    },
    beginTracing: async () => {
      const started = !recording;
      recording = true;

      return started;
    },
    isTracing: async () => recording,
    endTracing: async (keep) => {
      recording = false;
      calls.push(["end", keep]);

      return keep ? saved : null;
    },
  },
};

const { chromeWindows, devWindowNumber, devWindowAction, beginTracing, endTracing, isTracing } = await import("./nativeModule.ts");

test("developer window diagnostics preserve native ids, JSON strings and errors", async () => {
  const [window] = await chromeWindows();
  assert.equal(window.window, await devWindowNumber(42));
  assert.equal(await devWindowNumber(99), 0);
  assert.deepEqual(JSON.parse(await devWindowAction(window.window, "winfo")), { visible: true });
  assert.deepEqual(calls.pop(), [12, "winfo"]);
  rejectWindow = true;
  await assert.rejects(devWindowAction(12, "fakeFullScreen:1"), { code: "unsupported_action" });
  rejectWindow = false;
});

test("tracing facade returns start state and saved or discarded recordings", async () => {
  assert.equal(await isTracing(), false);
  assert.equal(await beginTracing(), true);
  assert.equal(await isTracing(), true);
  assert.equal(await beginTracing(), false);
  assert.equal(await endTracing(true), saved);
  assert.deepEqual(calls.pop(), ["end", true]);
  assert.equal(await isTracing(), false);
  assert.equal(await beginTracing(), true);
  assert.equal(await endTracing(false), null);
  assert.deepEqual(calls.pop(), ["end", false]);
  saved = null;
  await beginTracing();
  assert.equal(await endTracing(true), null);
});
