import assert from "node:assert/strict";
import test from "node:test";

import { addressToURL } from "../src/browser/address.ts";

test("normalizes website addresses and retains paths, queries and ports", () => {
  assert.equal(addressToURL(" example.com "), "https://example.com/");
  assert.equal(addressToURL("http://localhost:8081/page?q=bay#section"), "http://localhost:8081/page?q=bay#section");
  assert.equal(addressToURL("localhost:8081/page"), "https://localhost:8081/page");
  assert.equal(addressToURL("https://[::1]:8081/"), "https://[::1]:8081/");
});

test("rejects empty inputs, search terms, unsafe schemes and credentials", () => {
  for (const address of [
    "",
    "  ",
    "find a page",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "https://user:secret@example.com",
    "https://",
  ]) {
    assert.throws(() => addressToURL(address));
  }
});
