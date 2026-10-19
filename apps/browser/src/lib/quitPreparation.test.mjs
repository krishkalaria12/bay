import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareApplicationQuit } from "./quitPreparation.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness() {
  const calls = [], sync = deferred(), session = deferred(), live = deferred(), telemetry = deferred();
  let current = true;
  const owners = {
    isCurrent: () => current,
    prepareSync() { calls.push("sync"); return sync.promise; },
    flushSession() { calls.push("session"); return session.promise; },
    flushLive() { calls.push("live"); return live.promise; },
    flushTelemetry() { calls.push("telemetry"); return telemetry.promise; },
  };
  return { calls, sync, session, live, telemetry, owners, cancel() { current = false; } };
}

test("quit waits for sync mutations before document snapshots and fresh telemetry last", async () => {
  const h = harness();
  let done = false;
  const preparing = prepareApplicationQuit(h.owners).then(value => { done = true; return value; });
  assert.deepEqual(h.calls, ["sync"]);
  h.sync.resolve(); await settle();
  assert.deepEqual(h.calls, ["sync", "session", "live"]);
  h.session.resolve(); await settle();
  assert.equal(done, false);
  assert.equal(h.calls.includes("telemetry"), false);
  h.live.resolve(); await settle();
  assert.deepEqual(h.calls, ["sync", "session", "live", "telemetry"]);
  assert.equal(done, false);
  h.telemetry.resolve(); assert.equal(await preparing, true);
});

test("cancellation prevents later owners from freezing after an old attempt completes", async () => {
  for (const stage of ["before", "sync", "documents", "telemetry"]) {
    const h = harness();
    if (stage === "before") h.cancel();
    const preparing = prepareApplicationQuit(h.owners);
    if (stage === "sync") h.cancel();
    h.sync.resolve(); await settle();
    if (stage === "documents") h.cancel();
    h.session.resolve(); h.live.resolve(); await settle();
    if (stage === "telemetry") h.cancel();
    h.telemetry.resolve();
    assert.equal(await preparing, false);
    if (stage === "before") assert.deepEqual(h.calls, []);
    if (stage === "sync") assert.deepEqual(h.calls, ["sync"]);
    if (stage === "documents") assert.deepEqual(h.calls, ["sync", "session", "live"]);
  }
});

test("checkpoint failure rejects shutdown without starting subsequent stages", async () => {
  for (const stage of ["sync", "session", "live", "telemetry"]) {
    const h = harness();
    const preparing = prepareApplicationQuit(h.owners);
    const rejected = assert.rejects(preparing, /disk unavailable/);
    h.sync[stage === "sync" ? "reject" : "resolve"](new Error("disk unavailable"));
    await settle();
    if (stage !== "sync") {
      h.session[stage === "session" ? "reject" : "resolve"](new Error("disk unavailable"));
      h.live[stage === "live" ? "reject" : "resolve"](new Error("disk unavailable"));
      await settle();
      if (stage === "telemetry") h.telemetry.reject(new Error("disk unavailable"));
    }
    await rejected;
    if (stage !== "telemetry") assert.equal(h.calls.includes("telemetry"), false);
  }
});
