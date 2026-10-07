import assert from "node:assert/strict";
import { test } from "node:test";
import { currentPageActions, paletteStart } from "./paletteStart.ts";

const tab = (id, lastActiveAt, overrides = {}) => ({
  id, lastActiveAt, url: `https://${id}.example/`, title: id, customTitle: null, favicon: null, ...overrides,
});
const visit = (url, visits, lastVisit, overrides = {}) => ({ url, visits, lastVisit, title: "Page title", favicon: null, ...overrides });
const section = (result, id) => result.find((entry) => entry.id === id)?.items;

test("opening a current URL offers page actions with the URL and Markdown title", () => {
  const [section] = currentPageActions({ url: "https://example.com/changelog/0.0.10", title: "Release 0.0.10", customTitle: null });
  assert.equal(section.id, "page");
  assert.deepEqual(section.items.map(({ id, title }) => ({ id, title })), [
    { id: "copyUrl", title: "Copy Link" },
    { id: "copyUrlAsMarkdown", title: "Copy Markdown Link" },
    { id: "duplicateTab", title: "Duplicate Tab" },
  ]);
  assert.equal(section.items[0].detail, "example.com/changelog/0.0.10");
  assert.equal(section.items[1].detail, "[Release 0.0.10]");
});

test("page actions use renamed tabs and fall back to the URL for untitled pages", () => {
  const page = { url: "https://example.com/", title: "Original title", customTitle: "My page" };
  assert.equal(currentPageActions(page)[0].items[1].detail, "[My page]");
  assert.equal(currentPageActions({ ...page, title: "", customTitle: null })[0].items[1].detail, "[example.com]");
});

test("idle sections show recent other tabs before frequent sites", () => {
  const tabs = [
    tab("oldest", 1), tab("current", 200), tab("blank", 300, { url: "" }),
    tab("third", 30), tab("first", 50, { customTitle: "My project", favicon: "project-icon" }),
    tab("fourth", 20), tab("second", 40),
  ];
  const result = paletteStart(tabs, [visit("https://docs.example/document/123", 5, 5)], "current");
  assert.deepEqual(result.map((entry) => entry.id), ["recent", "frequent"]);
  const recent = section(result, "recent");
  assert.deepEqual(recent.map((item) => item.tabId), ["first", "second", "third", "fourth"]);
  assert.deepEqual(recent[0], { kind: "page", tabId: "first", url: "https://first.example/", title: "My project", favicon: "project-icon" });
});

test("frequent sites aggregate page visits by host and use recency to break count ties", () => {
  const history = [
    visit("https://alpha.example/old", 6, 10, { favicon: "old-icon" }),
    visit("https://beta.example/", 11, 25),
    visit("https://www.ALPHA.example/recent", 5, 30, { favicon: "latest-icon" }),
    visit("https://gamma.example/", 4, 40),
    visit("https://delta.example/", 1, 50),
  ];
  const frequent = section(paletteStart([], history, "current"), "frequent");
  assert.deepEqual(frequent.map((item) => item.title), ["alpha.example", "beta.example", "gamma.example"]);
  assert.equal(frequent[0].favicon, "latest-icon");
  assert.equal(frequent[0].url, "https://www.alpha.example/");
  assert.equal(frequent.some((item) => item.title === "delta.example"), false);
});

test("frequent links use the latest page origin with its scheme and port", () => {
  const history = [
    visit("https://localhost:8443/old", 2, 10, { favicon: "old" }),
    visit("http://localhost:3000/project?secret=value#section", 4, 20, { favicon: "new" }),
    visit("https://secure.example:9443/path?q=1#heading", 3, 15, { favicon: "secure" }),
  ];
  const frequent = section(paletteStart([], history, "current"), "frequent");
  assert.deepEqual(frequent.map(({ title, url, favicon }) => ({ title, url, favicon })), [
    { title: "localhost", url: "http://localhost:3000/", favicon: "new" },
    { title: "secure.example", url: "https://secure.example:9443/", favicon: "secure" },
  ]);
});

test("frequent sites still show when they're also open as recent tabs", () => {
  const tabs = [tab("current", 9), tab("open", 5, { url: "https://www.open.example/inbox" })];
  const history = [visit("https://open.example/", 9, 9), visit("https://other.example/", 1, 1)];
  const result = paletteStart(tabs, history, "current");
  assert.deepEqual(section(result, "frequent").map((item) => item.title), ["open.example", "other.example"]);
});

test("no tabs or history leaves the idle list empty", () => {
  assert.deepEqual(paletteStart([], [], "current"), []);
});

test("nonweb, internal and malformed history cannot enter frequent sites", () => {
  const history = ["bay://settings", "chrome://settings", "about:blank", "file:///private/file.html", "ftp://files.example/", "javascript:alert(1)", "https://", "https://:invalid"].map((url) => visit(url, 1000, 1000));
  history.push(visit("https://valid.example/article", 1, 1));
  const frequent = section(paletteStart([], history, "current"), "frequent");
  assert.deepEqual(frequent.map((item) => item.url), ["https://valid.example/"]);
  assert.equal(section(paletteStart([], history.slice(0, -1), "current"), "frequent"), undefined);
});

test("building idle sections leaves caller tab and history arrays unchanged", () => {
  const tabs = Object.freeze([Object.freeze(tab("first", 1)), Object.freeze(tab("second", 2))]);
  const history = Object.freeze([
    Object.freeze(visit("https://site.example/first", 2, 1)),
    Object.freeze(visit("https://site.example/second", 3, 2)),
  ]);
  const before = structuredClone({ tabs, history });
  const first = paletteStart(tabs, history, "current");
  const second = paletteStart(tabs, history, "current");
  assert.deepEqual({ tabs, history }, before);
  assert.deepEqual(second, first);
});
