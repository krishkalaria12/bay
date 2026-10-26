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
