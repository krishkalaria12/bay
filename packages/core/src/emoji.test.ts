import assert from "node:assert/strict";
import { test } from "node:test";
import { findEmoji } from "./emoji.ts";

test("emoji search requires an explicit prefix and a name", () => {
  for (const query of ["heart", "emoji", "emoji   ", "emojify heart", "emoji !!!", "emoji doesnotexist"]) {
    assert.deepEqual(findEmoji(query), []);
  }
});

test("heart searches put the red heart first and respect the result limit", () => {
  assert.deepEqual(findEmoji("emoji heart", 1), [{ value: "❤️", name: "red heart" }]);
  assert.equal(findEmoji("emoji heart").length, 5);
  assert.equal(findEmoji("emoji heart", 2).length, 2);
  assert.deepEqual(findEmoji("emoji heart", 0), []);
  assert.deepEqual(findEmoji("emoji heart", NaN), []);
});

test("emoji names support case, punctuation, accents and reordered partial words", () => {
  assert.deepEqual(findEmoji("  EMOJI RÉD-HEART  ", 1), [{ value: "❤️", name: "red heart" }]);
  assert.deepEqual(findEmoji("emoji FACE GRINN", 1), [{ value: "😀", name: "grinning face" }]);
  assert.deepEqual(findEmoji("emoji waving hand", 1), [{ value: "👋", name: "waving hand" }]);
});
