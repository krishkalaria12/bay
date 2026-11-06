import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOf } from "./tabTidying.ts";
import { splitOf } from "./splits.ts";

test("indexed group and split lookup preserves first-match order and invalidates on immutable edits", () => {
  const first = { id: "first", tabIds: ["a", "b"] };
  const second = { id: "second", tabIds: ["b", "c"] };
  const groups = { first, second };
  const splits = { first, second };

  for (const id of ["a", "b", "c", "missing", undefined, ""]) {
    assert.strictEqual(groupOf({ groups }, id), id ? Object.values(groups).find((g) => g.tabIds.includes(id)) : undefined);
    assert.strictEqual(splitOf({ splits }, id), id ? Object.values(splits).find((s) => s.tabIds.includes(id)) : undefined);
  }

  assert.strictEqual(groupOf({ groups: { second, first } }, "b"), second);
  assert.strictEqual(splitOf({ splits: { second, first } }, "b"), second);
  assert.strictEqual(groupOf({ groups: { ...groups, first: { ...first, tabIds: ["a"] } } }, "b"), second);
  assert.strictEqual(splitOf({ splits: { ...splits, first: { ...first, tabIds: ["a"] } } }, "b"), second);
  assert.strictEqual(groupOf({ groups }, "b"), first, "old snapshots retain their own index");
  assert.strictEqual(splitOf({ splits }, "b"), first);
});
