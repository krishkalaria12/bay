import assert from "node:assert/strict";
import test from "node:test";

import { incomingLink, bayCommand } from "../src/browser/incomingLink.ts";

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

test("a bay share link (B14) answers with the page it carries", () => {
  assert.equal(incomingLink("bay://share?url=https%3A%2F%2Fa.com%2Fstory%3Fa%3D1"), "https://a.com/story?a=1");
  // The page is validated like any incoming link.
  assert.equal(incomingLink("bay://share?url=example.com"), null);
  assert.equal(incomingLink("bay://share?url=mailto%3Aa%40example.com"), null);
  assert.equal(incomingLink("bay://share"), null);
  // Only the share shape carries a page; other bay links stay alone.
  assert.equal(incomingLink("bay://new-tab"), null);
});

test("a bay command (B15) names its action and leaves everything else alone", () => {
  assert.equal(bayCommand("bay://new-tab"), "new-tab");
  assert.equal(bayCommand("bay://private-tab"), "private-tab");
  assert.equal(bayCommand("bay://search"), "search");
  // Scheme and host are spelled by the OSes; the parser is case-insensitive like URL is.
  assert.equal(bayCommand("BAY://NEW-TAB"), "new-tab");
  assert.equal(bayCommand(null), null);
  assert.equal(bayCommand(""), null);
  // Pages, shares and junk are not commands.
  assert.equal(bayCommand("https://example.com/"), null);
  assert.equal(bayCommand("bay://share?url=https%3A%2F%2Fa.com%2F"), null);
  assert.equal(bayCommand("bay://example.com"), null);
  assert.equal(bayCommand("not a url"), null);
  // Only the bare command: anything with a path or a query would say what it answers, which these don't.
  assert.equal(bayCommand("bay://search?q=hi"), null);
  assert.equal(bayCommand("bay://new-tab/next"), null);
});
