import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFor, hostOf, parseHistory, parseSpaces, parseTabs } from "./parse.ts";

test("tabs keep what they need and drop what isn't one", () => {
  const tabs = parseTabs(
    JSON.stringify([
      { windowId: "w1", id: "t1", title: "Docs", url: "https://docs.example/", pinned: true, focused: false, space: "Work" },
      { title: "no id" },
      3,
    ]),
  );

  assert.deepEqual(tabs, [{ windowId: "w1", id: "t1", title: "Docs", url: "https://docs.example/", pinned: true, focused: false, space: "Work" }]);
  assert.deepEqual(parseTabs("not json"), []);
  assert.deepEqual(parseTabs('{"id":"x"}'), []);
});

test("spaces come in Bay's order", () => {
  const spaces = parseSpaces(
    JSON.stringify([
      { id: "b", name: "Work", index: 2 },
      { id: "a", name: "", index: 1, shown: true },
    ]),
  );

  assert.deepEqual(
    spaces.map((s) => [s.id, s.name, s.shown]),
    [
      ["a", "Space", true],
      ["b", "Work", false],
    ],
  );
});

test("history rows read seconds, milliseconds and dates", () => {
  const rows = parseHistory(
    JSON.stringify([
      { url: "https://a.example/", title: "A", visits: 3, last_visit: 1_790_000_000, space: "Personal" },
      { url: "https://b.example/", last_visit: "2026-11-26T09:00:00Z" },
      { title: "no url" },
    ]),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].lastVisit, 1_790_000_000_000);
  assert.equal(rows[1].title, "https://b.example/");
  assert.equal(rows[1].lastVisit, Date.parse("2026-11-26T09:00:00Z"));
});

test("typed addresses open as addresses, and nothing else does", () => {
  assert.equal(addressFor("example.com/a"), "https://example.com/a");
  assert.equal(addressFor("https://example.com"), "https://example.com");
  assert.equal(addressFor("localhost:3000"), "http://localhost:3000");
  assert.equal(addressFor("dev.internal:8080/x"), "http://dev.internal:8080/x");
  assert.equal(addressFor("bay://history"), "bay://history");
  assert.equal(addressFor("cats in hats"), null);
  assert.equal(addressFor("cats"), null);
  assert.equal(addressFor("  "), null);
  assert.equal(hostOf("https://docs.example/a"), "docs.example");
  assert.equal(hostOf("not a url"), "not a url");
});
