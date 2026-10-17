import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AWAKE_SITES, normalizeAwakeSite, normalizeAwakeSites, siteKeptAwake } from "./awakeSites.ts";

test("awake sites accept website URLs and normalize hosts", () => {
  assert.equal(normalizeAwakeSite(" HTTPS://Mail.Google.COM/inbox "), "mail.google.com");
  assert.equal(normalizeAwakeSite("example.com.:8080/path"), "example.com");
  assert.deepEqual(normalizeAwakeSites(["EXAMPLE.com", "https://example.com/path", "slack.com", ""]), ["example.com", "slack.com"]);
  assert.deepEqual(normalizeAwakeSites([null, 42, "example.com"]), ["example.com"]);
  for (const input of ["", "some words", "*.example.com", "javascript:alert(1)", "file:///tmp/file", "https://user:password@example.com"]) {
    assert.equal(normalizeAwakeSite(input), null, input);
  }
});

test("awake sites match subdomains at a dot boundary and only web pages", () => {
  assert.equal(siteKeptAwake("https://team.slack.com/messages", DEFAULT_AWAKE_SITES), true);
  assert.equal(siteKeptAwake("https://web.whatsapp.com/", DEFAULT_AWAKE_SITES), true);
  for (const url of ["https://fakeslack.com", "https://slack.com.evil.com", "bay://slack.com", "", undefined]) {
    assert.equal(siteKeptAwake(url, DEFAULT_AWAKE_SITES), false, url);
  }
});
