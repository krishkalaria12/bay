import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { changedIds, withChangedEntry } from "./changes.ts";

test("the delta cache does not retain previous record versions", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { changedIds, withChangedEntry } from ${JSON.stringify(new URL("./changes.ts", import.meta.url).href)};
    const make = (known) => {
      const previous = { a: {} };
      const latest = known ? withChangedEntry(previous, 'a', {}) : { a: {} };
      changedIds(latest, previous);
      return { latest, previous: new WeakRef(previous) };
    };
    const records = [make(false), make(true)];
    // End the job that created the WeakRefs before requesting a full collection.
    await new Promise(setImmediate);
    global.gc();
    for (const record of records) {
      assert.ok(record.latest.a, 'keep the latest record alive');
      assert.equal(record.previous.deref(), undefined, 'a live next version must not retain its predecessor');
    }
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test("single-entry updates reuse their known delta without enumerating records", () => {
  let scans = 0;
  const before = new Proxy(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), { i }])), {
    ownKeys(target) {
      scans++;
      return Reflect.ownKeys(target);
    },
  });
  const value = { i: 42, progress: 0.5 };
  const next = withChangedEntry(before, "42", value);
  assert.equal(scans, 1, "only the immutable copy enumerates the source");
  assert.strictEqual(next[42], value);
  assert.notStrictEqual(next[42], before[42]);
  assert.strictEqual(next[41], before[41]);
  for (let i = 0; i < 100; i++) assert.deepEqual(changedIds(next, before), ["42"]);
  assert.equal(scans, 1, "subscribers must not rediscover the change by scanning");
  assert.strictEqual(withChangedEntry(next, "42", value), next);
});

test("known deltas apply only to their exact predecessor, including chained updates", () => {
  const first = { a: { title: "A" }, b: { title: "B" } };
  const second = withChangedEntry(first, "a", { title: "A2" });
  const third = withChangedEntry(second, "b", { title: "B2" });
  assert.deepEqual(changedIds(third, second), ["b"]);
  assert.deepEqual(changedIds(third, first), ["a", "b"]);
  assert.deepEqual(changedIds(third, second), ["b"], "a different comparison cannot poison the immediate delta");
  assert.deepEqual(changedIds(second, first), ["a"]);
  const added = withChangedEntry(third, "c", { title: "C" });
  assert.deepEqual(changedIds(added, third), ["c"]);
  const removed = { a: added.a, c: added.c };
  assert.deepEqual(changedIds(removed, added), ["b"]);
  const replaced = { a: removed.a, d: { title: "D" } };
  assert.deepEqual(changedIds(replaced, removed), ["d", "c"]);
  assert.deepEqual(changedIds(replaced, replaced), []);
});
