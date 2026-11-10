import assert from "node:assert/strict";
import test from "node:test";

import { importedTabs } from "../src/browser/importTabs.ts";

test("finds links in a shared tab list, keeping the title before each one", () => {
  const tabs = importedTabs(`
    Arc Search tabs
    1. The quiet bay - https://example.com/bay
    Hacker News (https://news.ycombinator.com/)
    https://notitle.example/
  `);

  assert.deepEqual(tabs, [
    { url: "https://example.com/bay", title: "The quiet bay" },
    { url: "https://news.ycombinator.com/", title: "Hacker News" },
    { url: "https://notitle.example/", title: "" },
  ]);
});

test("reads markdown links, and drops the punctuation that follows them", () => {
  const tabs = importedTabs("[Arc](https://arc.net/), [Bay](https://bay.example/?a=1).\n- https://example.com/page;");

  assert.deepEqual(
    tabs.map((tab) => tab.url),
    ["https://arc.net/", "https://bay.example/?a=1", "https://example.com/page"],
  );
  assert.equal(tabs[0]?.title, "Arc");
});

test("deduplicates a link named more than once and ignores anything that isn't a web page", () => {
  const tabs = importedTabs(`
    https://example.com/
    https://example.com/
    mailto:hello@example.com
    ftp://example.com/file
    javascript:alert(1)
    example.com without a scheme
    https://user:secret@example.com/private
  `);

  assert.deepEqual(
    tabs.map((tab) => tab.url),
    ["https://example.com/"],
  );
});

test("an empty or link-free list imports nothing", () => {
  assert.deepEqual(importedTabs(""), []);
  assert.deepEqual(importedTabs("Just some notes\nwithout links."), []);
});

test("a very long title is cut down to a tab-sized one", () => {
  const [tab] = importedTabs(`${"a".repeat(400)} https://example.com/`);

  assert.equal(tab?.title.length, 300);
});
