import assert from "node:assert/strict";
import { test } from "node:test";
import { kindsWithoutUnlock } from "./constants.ts";

test("continuing a Linux basic-store import keeps passwords for the fixed-key reader", () => {
  const kinds = new Set(["passwords", "autofill", "bookmarks"]);
  const wanted = kindsWithoutUnlock(kinds, true);
  assert.deepEqual(wanted, kinds);
  assert.notStrictEqual(wanted, kinds);
});

test("skipping other platforms' locked data still imports addresses and bookmarks", () => {
  const kinds = new Set(["passwords", "cookies", "autofill", "bookmarks"]);
  assert.deepEqual(kindsWithoutUnlock(kinds, false), new Set(["autofill", "bookmarks"]));
  assert.ok(kinds.has("passwords") && kinds.has("cookies"));
});
