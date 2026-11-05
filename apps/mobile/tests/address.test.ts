import assert from "node:assert/strict";
import test from "node:test";

import { engineFor, resolveAddress } from "../src/browser/address.ts";

const google = engineFor("google");

test("opens website addresses and keeps paths, queries and ports", () => {
  assert.equal(resolveAddress(" example.com ", google), "https://example.com/");
  assert.equal(resolveAddress("http://localhost:8081/page?q=bay#section", google), "http://localhost:8081/page?q=bay#section");
  assert.equal(resolveAddress("localhost:8081/page", google), "http://localhost:8081/page");
  assert.equal(resolveAddress("https://[::1]:8081/", google), "https://[::1]:8081/");
});

test("searches with the chosen engine for anything that isn't a web address", () => {
  assert.equal(resolveAddress("find a page", google), "https://www.google.com/search?q=find%20a%20page");
  assert.equal(resolveAddress("?example.com", engineFor("duckduckgo")), "https://duckduckgo.com/?q=example.com");
  for (const input of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "https://user:secret@example.com"]) {
    assert.match(resolveAddress(input, google) ?? "", /^https:\/\/www\.google\.com\/search\?q=/);
  }
});

test("ignores empty input", () => {
  assert.equal(resolveAddress("", google), null);
  assert.equal(resolveAddress("  ", google), null);
  assert.equal(resolveAddress("?", google), null);
});

test("falls back to the first engine for an unknown id", () => {
  assert.equal(engineFor("missing").id, "google");
});
