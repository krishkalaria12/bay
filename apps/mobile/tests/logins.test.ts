import assert from "node:assert/strict";
import test from "node:test";

import { formatSavedLogins, originOf, parseSavedLogins } from "../src/browser/logins.ts";

test("saved logins survive a round trip", () => {
  const logins = [
    { origin: "https://example.com", username: "ada", password: "p4ss", savedAt: 42 },
    { origin: "https://mail.example.com:8443", username: "b@example.com", password: "x y", savedAt: 43 },
  ];

  assert.deepEqual(parseSavedLogins(formatSavedLogins(logins)), logins);
});

test("a torn or untrusted store parses to nothing, and a newer save of the same login wins", () => {
  assert.deepEqual(parseSavedLogins(null), []);
  assert.deepEqual(parseSavedLogins(""), []);
  assert.deepEqual(parseSavedLogins("not json"), []);
  assert.deepEqual(parseSavedLogins(JSON.stringify({ not: "a list" })), []);
  assert.deepEqual(
    parseSavedLogins(
      formatSavedLogins([
        { origin: "https://a.com", username: "u", password: "old", savedAt: 1 },
        { origin: "https://a.com", username: "u", password: "new", savedAt: 2 },
      ]),
    ),
    [{ origin: "https://a.com", username: "u", password: "new", savedAt: 2 }],
  );
  // A blank identity is not a login to offer.
  assert.deepEqual(parseSavedLogins(formatSavedLogins([{ origin: "", username: "", password: "p", savedAt: 1 }])), []);
});

test("origins carry scheme and port, and refuse non-pages", () => {
  assert.equal(originOf("https://example.com/path?x=1#frag"), "https://example.com");
  assert.equal(originOf("HTTP://EXAMPLE.COM:8080"), "http://example.com:8080");
  assert.equal(originOf("mailto:hello@example.com"), null);
  assert.equal(originOf("not a url"), null);
});
