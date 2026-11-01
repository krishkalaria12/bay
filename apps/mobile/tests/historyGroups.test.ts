import assert from "node:assert/strict";
import test from "node:test";

import { groupByDay } from "../src/panels/historyGroups.ts";

test("history groups by local day and drops empty groups", () => {
  const now = new Date(2026, 10, 2, 15, 0).getTime();
  const at = (month: number, day: number, hour: number) => ({ lastVisit: new Date(2026, month, day, hour).getTime() });
  const entries = [at(10, 2, 9), at(10, 2, 0), at(10, 1, 23), at(9, 29, 12), at(9, 1, 12)];
  assert.deepEqual(
    groupByDay(entries, now, (entry) => entry.lastVisit).map((group) => [group.label, group.entries.length]),
    [
      ["Today", 2],
      ["Yesterday", 1],
      ["This week", 1],
      ["Earlier", 1],
    ],
  );
  assert.deepEqual(
    groupByDay([at(10, 1, 8)], now, (entry) => entry.lastVisit).map((group) => group.label),
    ["Yesterday"],
  );
});
