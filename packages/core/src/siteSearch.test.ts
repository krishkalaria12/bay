import assert from "node:assert/strict";
import { test } from "node:test";
import { allEngines, BUILT_IN_ENGINES } from "./engines.ts";
import { findScope, scopedSearchUrl } from "./siteSearch.ts";

test("Arc-style default shortcuts enter a site scope and fill its search URL", () => {
  for (const [shortcut, name, url] of [
    ["yt", "YouTube", "https://www.youtube.com/results?search_query=react%20hooks"],
    ["w", "Wikipedia", "https://en.wikipedia.org/w/index.php?search=react%20hooks"],
    ["gh", "GitHub", "https://github.com/search?q=react%20hooks"],
    ["a", "Amazon", "https://www.amazon.com/s?k=react%20hooks"],
    ["r", "Reddit", "https://www.reddit.com/search/?q=react%20hooks"],
  ]) {
    const scope = findScope(shortcut!, { engines: BUILT_IN_ENGINES });
    assert.equal(scope?.name, name);
    assert.equal(scopedSearchUrl(scope!, "react hooks", BUILT_IN_ENGINES[0]!), url);
  }
});

test("custom shortcuts take priority over defaults while domains and site names still work", () => {
  const engines = allEngines([{ id: "work", name: "Work videos", keyword: "yt", url: "https://video.work.example/?q=%s" }]);
  assert.equal(findScope("yt", { engines })?.url, "https://video.work.example/?q=%s");
  assert.equal(findScope("YouTube", { engines })?.host, "youtube.com");
  assert.equal(findScope("github.com", { engines })?.host, "github.com");
  assert.equal(findScope("yt cats", { engines }), null);
  assert.equal(findScope("unknown-shortcut", { engines }), null);
});

test("scope matching does not collect known hosts for shortcuts or ordinary search words", () => {
  const hosts = () => {
    assert.fail("known hosts should only be read for a hostname without a built-in scope");
  };
  for (const text of ["", " ", "react", "react hooks", "gh", "yt", "google", "github.com", "https://www.youtube.com/"]) {
    assert.deepEqual(findScope(text, { engines: BUILT_IN_ENGINES, hosts }), findScope(text, { engines: BUILT_IN_ENGINES }));
  }
});

test("lazy known hosts preserve eager scope results and read the current source on each lookup", () => {
  let calls = 0;
  let current: readonly string[] = ["research.example", "other.example"];
  const hosts = () => {
    calls++;
    return current;
  };
  for (const text of ["research.example", "HTTPS://WWW.Research.Example/", "https://name:pass@research.example:8443/path", "unknown.example"]) {
    const before = calls;
    assert.deepEqual(findScope(text, { engines: BUILT_IN_ENGINES, hosts }), findScope(text, { engines: BUILT_IN_ENGINES, hosts: current }));
    assert.equal(calls, before + 1);
  }
  current = [];
  assert.equal(findScope("research.example", { engines: BUILT_IN_ENGINES, hosts }), null, "deleted history must not keep its scope");
  current = ["research.example"];
  assert.equal(findScope("research.example", { engines: BUILT_IN_ENGINES, hosts })?.kind, "history");
});

test("custom engine and popular-site scopes take priority over lazy history hosts", () => {
  const engines = allEngines([{ id: "custom", name: "Custom", keyword: "research.example", url: "https://search.example/?q=%s" }]);
  const hosts = () => {
    assert.fail("an already matched scope should not collect history hosts");
  };
  assert.equal(findScope("research.example", { engines, hosts })?.engineId, "custom");
  assert.equal(findScope("docs.github.com", { engines, hosts })?.host, "github.com");
});
