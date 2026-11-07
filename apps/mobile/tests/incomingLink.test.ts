import assert from "node:assert/strict";
import test from "node:test";

import { incomingLink } from "../src/browser/incomingLink.ts";

test("accepts web links as delivered and keeps their shape", () => {
  assert.equal(incomingLink("https://example.com/article?a=1#note"), "https://example.com/article?a=1#note");
  assert.equal(incomingLink("http://example.com/path"), "http://example.com/path");
  // A bare host (iOS can deliver a scheme-prefixed form with an empty path) still resolves.
  assert.equal(incomingLink("https://example.com"), "https://example.com/");
});

test("canonicalises what it can", () => {
  assert.equal(incomingLink("HTTP://EXAMPLE.COM/Page"), "http://example.com/Page");
  assert.equal(incomingLink("  https://example.com/  "), "https://example.com/");
});

test("leaves everything that isn't a web page alone", () => {
  assert.equal(incomingLink(null), null);
  assert.equal(incomingLink(""), null);
  assert.equal(incomingLink("example.com"), null);
  assert.equal(incomingLink("mailto:hello@example.com"), null);
  // Bay's own scheme in the dev client launch link (and any in-app deep link) is not a page.
  assert.equal(incomingLink("exp+bay://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"), null);
  assert.equal(incomingLink("bay://example.com"), null);
  // Credentials are refused, as the engines refuse them everywhere.
  assert.equal(incomingLink("https://user:pass@example.com/"), null);
});
