import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { docs, heldSaves, writeDocument } from "../test-native-stub.mjs";
import { useBrowser } from "../store/browser.ts";

globalThis.nnTelemetryTestWriteDocument = writeDocument;
const shell = new URL("../test-native-stub.mjs", import.meta.url).href;
const shellWithControlledWrites = `
  export { launchEnvironment, readDocument, saveDocument, systemInfo } from ${JSON.stringify(shell)};
  export function writeDocument(...args) { globalThis.nnTelemetryTestWriteDocument(...args); }
`;

// Usage's quit accounting is real; only unrelated UI/sync observers and the
// native crash reporter are stubbed to avoid loading React Native UI in Node.
const observers = {
  "@bay/nncore": "export async function listTasks() { return []; } export function onExtensionsChanged() {}",
  "../components/site/translate": "export const useTranslate = { subscribe() {} };",
  "../sync/engine": "export const useSync = { getState: () => ({ status: 'off' }), subscribe() {} };",
  "./errors": "export async function reportNativeCrashes() {}",
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/telemetry/client.ts") && specifier === "@bay/shell") {
      return { url: `data:text/javascript,${encodeURIComponent(shellWithControlledWrites)}`, shortCircuit: true };
    }
    if (context.parentURL?.endsWith("/telemetry/usage.ts") && specifier in observers) {
      return { url: `data:text/javascript,${encodeURIComponent(observers[specifier])}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { capture, devState, flush, queueLog, requestLog, setSharing } = await import("./client.ts");
const { prepareTelemetryForQuit, resumeTelemetryAfterQuit, startUsage } = await import("./usage.ts");
hooks.deregister();
globalThis.__DEV__ = false;
const settle = () => new Promise(setImmediate);
const state = () => JSON.parse(docs.get("telemetry.json"));
const queue = () => JSON.parse(docs.get("telemetry-queue.json"));
const release = () => heldSaves.queue.splice(0).forEach((done) => done());

beforeEach(async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  globalThis.nnTelemetryTestWriteDocument = writeDocument;
  heldSaves.on = false;
  heldSaves.error = null;
  await resumeTelemetryAfterQuit();
  setSharing(false, "settings");
  docs.clear();
  setSharing(true, "settings");
});
afterEach(async () => {
  globalThis.nnTelemetryTestWriteDocument = writeDocument;
  heldSaves.on = false;
  heldSaves.error = null;
  release();
  await resumeTelemetryAfterQuit();
  setSharing(false, "settings");
});

test("quit checkpoints both documents once per attempt and waits for both acknowledgements", async () => {
  capture("before_quit");
  queueLog("warn", "test warning", {});
  heldSaves.on = true;
  const checkpoint = prepareTelemetryForQuit();
  assert.strictEqual(prepareTelemetryForQuit(), checkpoint);
  let finished = false;
  void checkpoint.then(() => {
    finished = true;
  });
  await settle();
  assert.equal(heldSaves.queue.length, 2);
  heldSaves.queue.shift()();
  await settle();
  assert.equal(finished, false);
  heldSaves.queue.shift()();
  await checkpoint;
  assert.equal(state().sessionOpen, false);
  assert.equal(queue().events.filter((e) => e.event === "app_session_ended").length, 1);
  assert.ok(queue().events.some((e) => e.event === "before_quit"));
  assert.equal(queue().logs.length, 1);
});

test("cancellation repairs late writes using current queue and opens the session", async () => {
  heldSaves.on = true;
  const old = prepareTelemetryForQuit();
  await settle();
  const resumed = resumeTelemetryAfterQuit();
  capture("after_cancel");
  assert.equal(devState().saved.sessionOpen, true);
  // These stale writes land after cancellation's background writes. The repair
  // waits for both, then checkpoints the live state rather than the old bytes.
  release();
  await old;
  await settle();
  assert.equal(heldSaves.queue.length, 2);
  release();
  await resumed;
  assert.equal(state().sessionOpen, true);
  assert.ok(queue().events.some((e) => e.event === "after_cancel"));
  assert.equal(queue().events.filter((e) => e.event === "app_session_ended").length, 1);
  heldSaves.on = false;
  await prepareTelemetryForQuit();
  assert.equal(queue().events.filter((e) => e.event === "app_session_ended").length, 2);
});

test("failed writes reject quit and cancellation retries without losing queued events", async () => {
  capture("keep_on_failure");
  heldSaves.error = new Error("disk full");
  await assert.rejects(prepareTelemetryForQuit(), /disk full/);
  heldSaves.error = null;
  await resumeTelemetryAfterQuit();
  assert.equal(state().sessionOpen, true);
  assert.ok(queue().events.some((e) => e.event === "keep_on_failure"));
  await prepareTelemetryForQuit();
  assert.equal(state().sessionOpen, false);
});

test("new attempts serialize after cancelled checkpoints without an old repair reopening them", async () => {
  heldSaves.on = true;
  const old = prepareTelemetryForQuit();
  await settle();
  const cancelled = resumeTelemetryAfterQuit();
  capture("between_attempts");
  const current = prepareTelemetryForQuit();
  release();
  await old;
  await cancelled;
  await settle();
  assert.equal(heldSaves.queue.length, 2);
  release();
  await current;
  assert.equal(state().sessionOpen, false);
  assert.ok(queue().events.some((e) => e.event === "between_attempts"));
});

test("opting out during checkpoint keeps the current empty queue and deleted identity", async () => {
  heldSaves.on = true;
  const checkpoint = prepareTelemetryForQuit();
  await settle();
  setSharing(false, "settings");
  release();
  await settle();
  assert.equal(heldSaves.queue.length, 2);
  release();
  await checkpoint;
  heldSaves.on = false;
  await resumeTelemetryAfterQuit();
  assert.equal(state().sharing, false);
  assert.equal(state().installId, null);
  assert.equal(state().sessionOpen, false);
  assert.deepEqual(queue(), { version: 1, events: [], logs: [] });
});

test("opting out after a completed checkpoint still clears persisted diagnostics immediately", async () => {
  capture("delete_after_checkpoint");
  await prepareTelemetryForQuit();
  assert.ok(queue().events.length);
  setSharing(false, "settings");
  assert.equal(state().installId, null);
  assert.deepEqual(queue(), { version: 1, events: [], logs: [] });
  await resumeTelemetryAfterQuit();
  assert.equal(state().sessionOpen, false);
  assert.equal(state().sharing, false);
});

for (const mode of ["delayed", "failed"]) {
  test(`a completed checkpoint is refreshed after opt-out with ${mode} background writes`, async () => {
    capture("delete_after_completed_checkpoint");
    const first = prepareTelemetryForQuit();
    await first;
    assert.equal(state().sharing, true);
    const background = [];
    globalThis.nnTelemetryTestWriteDocument = (...args) => {
      if (mode === "failed") throw new Error("background disk failure");
      background.push(() => writeDocument(...args));
    };
    setSharing(false, "settings");
    assert.equal(state().sharing, true); // Background writes have not reached disk.
    heldSaves.on = true;
    const refreshed = prepareTelemetryForQuit();
    assert.notStrictEqual(refreshed, first);
    assert.strictEqual(prepareTelemetryForQuit(), refreshed);
    let finished = false;
    void refreshed.then(() => {
      finished = true;
    });
    await settle();
    assert.equal(heldSaves.queue.length, 2);
    // Native queues each acknowledgement after earlier background writes.
    background.forEach((land) => land());
    heldSaves.queue.shift()();
    await settle();
    assert.equal(finished, false);
    heldSaves.queue.shift()();
    await refreshed;
    assert.equal(state().sharing, false);
    assert.equal(state().installId, null);
    assert.deepEqual(queue(), { version: 1, events: [], logs: [] });
    assert.strictEqual(prepareTelemetryForQuit(), refreshed);
  });
}

test("a failed refreshed checkpoint rejects and cancellation repairs the opted-out state", async () => {
  await prepareTelemetryForQuit();
  globalThis.nnTelemetryTestWriteDocument = () => {
    throw new Error("background disk failure");
  };
  setSharing(false, "settings");
  heldSaves.error = new Error("acknowledged disk failure");
  await assert.rejects(prepareTelemetryForQuit(), /acknowledged disk failure/);
  assert.equal(state().sharing, true);
  heldSaves.error = null;
  await resumeTelemetryAfterQuit();
  assert.equal(state().sharing, false);
  assert.equal(state().sessionOpen, false);
  assert.equal(state().installId, null);
  assert.deepEqual(queue(), { version: 1, events: [], logs: [] });
});

test("refreshing a checkpoint does not repeat session accounting", async () => {
  await prepareTelemetryForQuit();
  capture("after_first_checkpoint");
  await prepareTelemetryForQuit();
  assert.equal(queue().events.filter((event) => event.event === "app_session_ended").length, 1);
  assert.ok(queue().events.some((event) => event.event === "after_first_checkpoint"));
});

test("quit aborts uploads, starts no new requests and ignores late results after resume", async (context) => {
  const pending = [];
  context.mock.method(globalThis, "fetch", (_url, options) => new Promise((resolve) => pending.push({ options, resolve })));
  capture("retained_upload");
  const sending = flush();
  assert.equal(pending.length, 1);
  const requestsBefore = requestLog().length;
  await prepareTelemetryForQuit();
  assert.equal(pending[0].options.signal.aborted, true);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(pending.length, 1);
  await resumeTelemetryAfterQuit();
  pending[0].resolve({ status: 200 });
  await sending;
  assert.equal(requestLog().length, requestsBefore);
  assert.ok(queue().events.some((e) => e.event === "retained_upload"));
  context.mock.timers.tick(30_000);
  assert.equal(pending.length, 2);
  pending[1].resolve({ status: 200 });
  await settle();
  assert.equal(devState().queued.events, 0);
});

test("cancelled quit preserves new usage counts instead of resetting the resumed counters", async () => {
  startUsage();
  useBrowser.getState().createWindow({ url: "https://first.example/" });
  await prepareTelemetryForQuit();
  const first = queue().events.filter((e) => e.event === "usage_counts");
  assert.equal(first.length, 1);
  await resumeTelemetryAfterQuit();
  useBrowser.getState().createWindow({ url: "https://second.example/" });
  await prepareTelemetryForQuit();
  const counts = queue().events.filter((e) => e.event === "usage_counts");
  assert.equal(counts.length, 2);
  assert.equal(counts[0].properties.windows_opened, 1);
  assert.equal(counts[1].properties.windows_opened, 1);
});
