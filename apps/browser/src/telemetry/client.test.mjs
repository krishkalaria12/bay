import assert from "node:assert/strict";
import { test } from "node:test";

const { devState, requestLog, setSharing, startClient, uuidv7 } = await import("./client.ts");
const { slowTimersForTests } = await import("../lib/throttledTimers.ts");

test("event IDs are complete version 7 UUIDs", () => {
  const ids = Array.from({ length: 100 }, () => uuidv7());

  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  assert.equal(new Set(ids).size, ids.length);
});

test("opting in after starting with sharing off starts scheduled delivery", async () => {
  globalThis.__DEV__ = true;
  let now = 1_000_000_020_000;
  const lab = slowTimersForTests(() => now);

  assert.equal(startClient(), null);

  try {
    setSharing(true, "settings");

    for (let attempt = 0; attempt < 100 && lab.pending() === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.notEqual(lab.pending(), null, "opting in registered a delivery job");
    now += 30_000;
    lab.fire();

    for (let attempt = 0; attempt < 100 && requestLog().length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.equal(requestLog().length, 1);
    assert.equal(requestLog()[0].dryRun, true);
    assert.deepEqual(devState().queued, { events: 0, logs: 0 });
  } finally {
    setSharing(false, "settings");
    const { disposeDesktopRuntime } = await import("../effect/runtime.ts");

    await disposeDesktopRuntime();
    lab.clear();
    globalThis.__DEV__ = false;
  }
});
