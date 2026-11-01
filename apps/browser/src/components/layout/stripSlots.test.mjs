import assert from "node:assert/strict";
import { test } from "node:test";
import { firstSlotIndexes } from "./stripSlots.ts";

test("slot lookup preserves first-head matches, split membership and empty group behavior", () => {
  const slots = [{ tabIds: ["a", "split-pane"] }, { tabIds: [] }, { tabIds: ["b", "group-member"] }, { tabIds: ["a"] }, { tabIds: [""] }, { tabIds: [] }];
  const indexes = firstSlotIndexes(slots);
  for (const id of ["a", "split-pane", "b", "group-member", "", undefined, "missing"])
    assert.equal(
      indexes.get(id) ?? -1,
      slots.findIndex((slot) => slot.tabIds[0] === id),
    );
  assert.equal(indexes.get("") ?? -1, 4, "empty group uses the existing empty-string sentinel");
  assert.equal(firstSlotIndexes([{ tabIds: [] }]).get("") ?? -1, -1);
  assert.equal(firstSlotIndexes([]).get("a") ?? -1, -1);
});
