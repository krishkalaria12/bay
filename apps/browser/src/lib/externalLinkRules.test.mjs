import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLinkDestination, matchingLinkRule, normalizeExternalLinkRules, validateLinkPattern } from "./externalLinkRules.ts";
import { mostRecentSpace } from "../store/small.ts";
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

test("contains matches literal text anywhere in the URL, including queries and fragments", () => {
  for (const [pattern, url] of [
    ["spotify.com", "https://open.spotify.com/album/123"],
    ["view=board", "https://example.com/work?view=board#today"],
    ["#today", "https://example.com/work?view=board#today"],
    ["café", "https://example.com/caf%C3%A9/report"],
    ["café", "https://example.com/café/report"],
    ["weekly report", "https://example.com/weekly%20report"],
    ["example.com", "https://other.test/?next=example.com"],
  ]) {
    const route = rule(pattern, { matchType: "contains" });
    assert.equal(validateLinkPattern(pattern, route.matchType), null);
    assert.equal(matchingLinkRule([route], url), route, `${pattern} matches ${url}`);
  }
  assert.equal(matchingLinkRule([rule("example.com/*", { matchType: "contains" })], "https://example.com/page"), undefined, "stars are literal");
  assert.equal(matchingLinkRule([rule("example.com", { matchType: "contains" })], "file:///example.com"), undefined);
  assert.equal(matchingLinkRule([rule("\ud800", { matchType: "contains" })], "https://example.com"), undefined, "malformed text never crashes routing");
  assert.ok(validateLinkPattern("  ", "contains"));
  assert.ok(validateLinkPattern("bad\ntext", "contains"));
});

test("equal routes compare complete URLs, including query, fragment and encoded Unicode", () => {
  const route = rule("https://example.com/café?report=weekly#today", { matchType: "equals" });
  assert.equal(validateLinkPattern(route.pattern, route.matchType), null);
  assert.equal(matchingLinkRule([route], "https://EXAMPLE.com/caf%C3%A9?report=weekly#today"), route);
  for (const url of [
    "http://example.com/café?report=weekly#today",
    "https://example.com/café?report=daily#today",
    "https://example.com/café?report=weekly#other",
    "https://example.com/café?report=weekly#today-extra",
  ])
    assert.equal(matchingLinkRule([route], url), undefined, url);
  for (const pattern of ["example.com", "javascript:alert(1)", "file:///report", "https://"]) assert.ok(validateLinkPattern(pattern, "equals"), pattern);
  assert.deepEqual(normalizeExternalLinkRules([route, rule("example.com", { matchType: "invalid" })]), [route]);
  for (const [pattern, other] of [
    ["https://example.com/report", "https://example.com/report/"],
    ["https://example.com/a%2Fb", "https://example.com/a/b"],
    ["https://example.com/%2541", "https://example.com/%41"],
  ]) {
    const exact = rule(pattern, { matchType: "equals" });
    assert.equal(matchingLinkRule([exact], pattern), exact);
    assert.equal(matchingLinkRule([exact], other), undefined);
  }
});

test("routing does not depend on React Native's incomplete URL shim", () => {
  const NativeURL = globalThis.URL;
  globalThis.URL = class {
    constructor() {
      throw new Error("URL must not be used for routing");
    }
  };
  try {
    const exact = rule("https://example.com/café?report=weekly#today", { matchType: "equals" });
    assert.equal(matchingLinkRule([exact], "https://example.com/caf%C3%A9?report=weekly#today"), exact);
    assert.equal(matchingLinkRule([exact], "https://example.com/caf%C3%A9/?report=weekly#today"), undefined);
    const legacy = rule("example.com/café/*");
    assert.equal(matchingLinkRule([legacy], "https://example.com/caf%C3%A9/page"), legacy);
    assert.equal(validateLinkPattern("not a url", "equals") !== null, true);
  } finally {
    globalThis.URL = NativeURL;
  }
});

test("exact URL matching uses component-specific escaping and normalized Unicode hostnames", () => {
  const literal = rule("https://example.com/[a]", { matchType: "equals" });
  assert.equal(matchingLinkRule([literal], "https://example.com/[a]"), literal);
  assert.equal(matchingLinkRule([literal], "https://example.com/%5Ba%5D"), undefined);
  const query = rule("https://example.com/?q=O'Reilly", { matchType: "equals" });
  assert.equal(matchingLinkRule([query], "https://example.com/?q=O%27Reilly"), query);
  const caret = rule("https://example.com/a^b", { matchType: "equals" });
  assert.equal(matchingLinkRule([caret], "https://example.com/a%5Eb"), caret);
  const hostname = rule("https://cafe\u0301.example/report", { matchType: "equals" });
  assert.equal(matchingLinkRule([hostname], "https://xn--caf-dma.example/report"), hostname);
  const contains = rule("[a]", { matchType: "contains" });
  assert.equal(matchingLinkRule([contains], "https://example.com/[a]"), contains);
  assert.equal(matchingLinkRule([contains], "https://example.com/%5Ba%5D"), undefined);
  for (const pattern of ["q=O'Reilly", "https://example.com/?q=O'Reilly"]) {
    const route = rule(pattern, { matchType: "contains" });
    for (const url of ["https://example.com/?q=O'Reilly", "https://example.com/?q=O%27Reilly"]) assert.equal(matchingLinkRule([route], url), route);
  }
});

test("saved wildcard routes canonicalize Unicode paths and dot segments", () => {
  for (const [pattern, url] of [
    ["example.com/café/*", "https://example.com/caf%C3%A9/page"],
    ["example.com/a/../report", "https://example.com/report"],
  ]) {
    const route = rule(pattern);
    assert.equal(validateLinkPattern(pattern), null);
    assert.equal(matchingLinkRule([route], url), route);
  }
});

test("routing defaults preserve saved choices and most recent excludes private and small windows", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "littleBay" });
  S().hydrate({ settings: { openLinksInLittleBay: false } });
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "mostRecentSpace" });
  const work = S().createSpace({ name: "Work" });
  const main = S().createWindow({ spaceId: work });
  S().createWindow({ incognito: true });
  S().createWindow({ small: true });
  assert.equal(mostRecentSpace(S()), work);
  S().switchSpace(main, "default");
  assert.equal(mostRecentSpace(S()), "default");
  S().switchSpace(main, work);
  assert.equal(mostRecentSpace(S()), work);
  S().updateSettings({ externalLinkDefault: { kind: "mostRecentSpace" } });
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "mostRecentSpace" });
  docs.clear();
  const stop = startPersistence();
  S().updateSettings({ externalLinkDefault: { kind: "mostRecentSpace" } });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "mostRecentSpace" });
  S().updateSettings({ externalLinkDefault: { kind: "space", spaceId: work } });
  assert.equal(S().settings.openLinksInLittleBay, false);
  S().updateSettings({ openLinksInLittleBay: true });
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "littleBay" });
  S().hydrate({ settings: { externalLinkDefault: { kind: "unknown" } } });
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "littleBay" });
});

test("deleting a Space removes its local and synced routes and repairs the default", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const work = S().createSpace({ name: "Work" });
  S().updateSettings({
    externalLinkDefault: { kind: "space", spaceId: work },
    externalLinkRules: [
      rule("local.example", { destination: { kind: "space", spaceId: work } }),
      rule("synced.example", { destination: { kind: "space", spaceId: work, syncProfileId: "remote" } }),
      rule("unrelated.example"),
    ],
  });
  S().deleteSpace(work);
  assert.deepEqual(
    S().settings.externalLinkRules.map((r) => r.id),
    ["unrelated.example"],
  );
  assert.deepEqual(defaultLinkDestination(S().settings), { kind: "space", spaceId: "default" });
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
