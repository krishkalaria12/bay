import assert from "node:assert/strict";
import { test } from "node:test";
import { matchingLinkRule, normalizeExternalLinkRules, validateLinkPattern } from "./externalLinkRules.ts";
import { useBrowser } from "../store/browser.ts";
import { flushPersistence, loadSession, startPersistence } from "./persist.ts";
import { docs } from "../test-native-stub.mjs";

const rule = (pattern, rest = {}) => ({ id: pattern, pattern, destination: { kind: "newWindow" }, ...rest });

test("host/path wildcards respect host boundaries, path case and source-app priority", () => {
  const specific = rule("github.com/acme/*", { sourceApp: "com.tinyspeck.slackmacgap" });
  const general = rule("github.com");
  assert.equal(matchingLinkRule([specific, general], "https://GITHUB.com/acme/pr?x=1", specific.sourceApp), specific);
  assert.equal(matchingLinkRule([general, specific], "https://github.com/acme/pr", specific.sourceApp), general);
  assert.equal(matchingLinkRule([specific, general], "https://github.com/acme/pr"), general);
  assert.equal(matchingLinkRule([specific], "https://github.com/ACME/pr", specific.sourceApp), undefined);
  for (const url of [
    "https://github.com.evil.test/acme/pr",
    "https://evil.test/github.com/acme/pr",
    "https://evil.test/?url=github.com/acme/pr",
    "not a url",
    "file:///github.com/acme/pr",
  ]) {
    assert.equal(matchingLinkRule([general], url), undefined, url);
  }
  assert.ok(matchingLinkRule([rule("*.example.com/*")], "https://docs.example.com/page"));
  assert.ok(matchingLinkRule([rule("example.com/files/*")], "https://example.com/files/*draft"));
  for (const url of ["https://example.com:443/page", "http://example.com:80/page", "http://127.1/page"]) {
    assert.ok(matchingLinkRule([rule(url.replace(/page$/, "*"))], url), url);
  }
  assert.ok(matchingLinkRule([rule("example.com:443/*")], "https://example.com/page"));
  assert.ok(matchingLinkRule([rule("http://*.example.com:80/*")], "http://docs.example.com/page"));
  assert.equal(matchingLinkRule([rule("https://example.com/one")], "http://example.com/one"), undefined);
  assert.equal(matchingLinkRule([rule("example.com/one")], "https://example.com/one/two"), undefined);
  for (const pattern of ["", "https://", "evil@example.com", "javascript:alert(1)", "example.com/path?query", "example.com\\evil", "[broken"])
    assert.ok(validateLinkPattern(pattern), pattern);
});

test("old sessions default to no rules; rule order and source app survive persistence", () => {
  const S = () => useBrowser.getState();
  S().hydrate({ settings: { openLinksInLittleBay: true } });
  assert.deepEqual(S().settings.externalLinkRules, []);
  const rules = [rule("linear.app/*", { sourceApp: "com.tinyspeck.slackmacgap", destination: { kind: "space", spaceId: "default" } }), rule("example.com")];
  docs.clear();
  const stop = startPersistence();
  S().updateSettings({ externalLinkRules: rules, openLinksInLittleBay: true });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  assert.deepEqual(S().settings.externalLinkRules, rules);
  assert.equal(S().settings.openLinksInLittleBay, true);
  assert.deepEqual(
    normalizeExternalLinkRules([null, {}, rules[0], rules[0], rule("bad.com", { sourceApp: [] }), rule("bad.test", { destination: { kind: "unknown" } })]),
    [rules[0]],
  );
  S().hydrate({ settings: { externalLinkRules: null } });
  assert.deepEqual(S().settings.externalLinkRules, []);
});
