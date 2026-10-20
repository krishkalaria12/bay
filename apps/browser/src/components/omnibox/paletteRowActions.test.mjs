import assert from "node:assert/strict";
import { test } from "node:test";
import { forgettable, isSearchResultsPage, rowMenuActions } from "./paletteRowActions.ts";

const calls = [];
const handlers = {
  choose: (s, disposition) => calls.push(["choose", s.url, disposition]),
  openInBackground: (url) => calls.push(["background", url]),
  copyLink: (url) => calls.push(["copy", url]),
  closeTab: (id) => calls.push(["close", id]),
  forget: (s) => calls.push(["forget", s.url]),
};
const page = (overrides = {}) => ({ kind: "page", url: "https://x.com/", title: "X", favicon: null, visited: true, ...overrides });
const summary = (actions) => actions.map(({ title, hint, separator }) => [title, hint ?? null, !!separator]);

test("a history page opens in place, in a new or background tab, copies, and can be forgotten", () => {
  assert.deepEqual(summary(rowMenuActions(page(), false, [], handlers)), [
    ["Open", "↩", false],
    ["Open in New Tab", "⌘↩", false],
    ["Open in Background Tab", null, false],
    ["Copy Link", "⇧⌘C", false],
    ["Forget This Page", "⇧⌫", true],
  ]);
});

test("in the new tab panel ↩ opens a new tab and ⌘↩ a background tab", () => {
  assert.deepEqual(summary(rowMenuActions(page(), true, [], handlers)).slice(0, 2), [
    ["Open in New Tab", "↩", false],
    ["Open in Background Tab", "⌘↩", false],
  ]);
});

test("open tabs switch and close instead of being forgotten", () => {
  const actions = rowMenuActions(page({ tabId: "t1" }), false, [], handlers);
  assert.equal(actions[0].title, "Switch to Tab");
  assert.equal(actions.at(-1).title, "Close Tab");
  calls.length = 0;
  actions.at(-1).run();
  assert.deepEqual(calls, [["close", "t1"]]);
});

test("frequent sites forget the whole site", () => {
  const site = page({ host: "x.com", visited: undefined });
  assert.equal(forgettable(site), true);
  assert.equal(rowMenuActions(site, false, [], handlers).at(-1).title, "Forget This Site");
});

test("actions run their handlers with the row's URL", () => {
  calls.length = 0;
  for (const action of rowMenuActions(page(), false, [], handlers)) action.run();
  assert.deepEqual(calls, [
    ["choose", "https://x.com/", undefined],
    ["choose", "https://x.com/", "newTab"],
    ["background", "https://x.com/"],
    ["copy", "https://x.com/"],
    ["forget", "https://x.com/"],
  ]);
});

test("rows without a URL only offer their primary action", () => {
  assert.deepEqual(summary(rowMenuActions({ kind: "action", id: "copyUrl", title: "Copy Link", icon: "link" }, false, [], handlers)), [
    ["Copy Link", "↩", false],
  ]);
  assert.equal(forgettable(page({ visited: false })), false);
  assert.equal(forgettable({ kind: "search", query: "q", url: "https://s/?q", engine: "e" }), false);
});

test("emoji rows only copy the emoji, including from the new tab panel", () => {
  const emoji = { kind: "emoji", value: "👩🏽‍💻", name: "woman technologist: medium skin tone" };
  const chosen = [];
  const copyHandlers = { ...handlers, choose: (...args) => chosen.push(args) };
  for (const newTabPanel of [false, true]) {
    const actions = rowMenuActions(emoji, newTabPanel, [], copyHandlers);
    assert.deepEqual(summary(actions), [["Copy Emoji", "↩", false]]);
    assert.equal(actions[0].icon, "doc.on.doc");
    actions[0].run();
    assert.equal(forgettable(emoji), false);
  }
  assert.deepEqual(chosen, [[emoji], [emoji]]);
});

const engines = ["https://www.google.com/search?q=%s", "https://duckduckgo.com/?q=%s", "https://www.google.com/maps/search/%s"];

test("search suggestions and visited search results pages can't be forgotten", () => {
  const results = page({ url: "https://www.google.com/search?q=bay+browser&sca_esv=1", title: "bay browser - Google Search" });
  assert.equal(forgettable(results, engines), false);
  assert.equal(
    rowMenuActions(results, false, engines, handlers).some((a) => a.id === "forget"),
    false,
  );
  const suggestion = { kind: "search", query: "bay", url: "https://www.google.com/search?q=bay", engine: "Google", suggested: true };
  assert.equal(
    rowMenuActions(suggestion, false, engines, handlers).some((a) => a.id === "forget"),
    false,
  );
});

test("search results pages are matched by engine host, path and query key", () => {
  assert.equal(isSearchResultsPage("https://google.com/search?client=safari&q=x", engines), true);
  assert.equal(isSearchResultsPage("https://duckduckgo.com/?q=x&ia=web", engines), true);
  assert.equal(isSearchResultsPage("https://www.google.com/maps/search/coffee", engines), true);
  assert.equal(isSearchResultsPage("https://duckduckgo.com/", engines), false);
  assert.equal(isSearchResultsPage("https://www.google.com/search/howsearchworks/", engines), false);
  assert.equal(isSearchResultsPage("https://mail.google.com/search?q=x", engines), false);
  assert.equal(forgettable(page({ url: "https://www.google.com/maps/place/x" }), engines), true);
});
