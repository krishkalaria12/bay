import assert from "node:assert/strict";
import test from "node:test";

import { FILTER_LISTS, isStale, listUnchanged, listVersion, looksLikeFilterList, REFRESH_AFTER } from "../src/privacy/filterLists.ts";

test("lists refresh daily and when the clock went backwards", () => {
  assert.equal(isStale(undefined, 0), true);
  assert.equal(isStale(1000, 1000 + REFRESH_AFTER - 1), false);
  assert.equal(isStale(1000, 1000 + REFRESH_AFTER), true);
  assert.equal(isStale(5000, 1000), true);
});

test("a list is current when its ETag, or else its Last-Modified, is unchanged", () => {
  assert.equal(listUnchanged({ etag: '"a"' }, { etag: '"a"' }), true);
  assert.equal(listUnchanged({ etag: '"a"', lastModified: "Mon" }, { etag: '"b"', lastModified: "Mon" }), false);
  assert.equal(listUnchanged({ lastModified: "Mon" }, { etag: '"a"', lastModified: "Mon" }), true);
  assert.equal(listUnchanged({ lastModified: "Mon" }, { lastModified: "Tue" }), false);
  assert.equal(listUnchanged({}, {}), false);
});

test("versions change with the text", () => {
  assert.equal(listVersion("||ads.example^"), listVersion("||ads.example^"));
  assert.notEqual(listVersion("||ads.example^"), listVersion("||ads.example^\n"));
});

test("error pages aren't taken for lists", () => {
  assert.equal(looksLikeFilterList("! Title: List\n||a.example^\n", 50_000), true);
  assert.equal(looksLikeFilterList("<!DOCTYPE html><html>", 50_000), false);
  assert.equal(looksLikeFilterList("||short^", 9), false);
});

test("every list has a unique id and an HTTPS address", () => {
  assert.equal(new Set(FILTER_LISTS.map((list) => list.id)).size, FILTER_LISTS.length);
  for (const list of FILTER_LISTS) assert.match(list.url, /^https:\/\//);
});
