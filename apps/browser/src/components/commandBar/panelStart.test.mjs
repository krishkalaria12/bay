import assert from "node:assert/strict";
import { test } from "node:test";
import { currentPageActions, paletteStart } from "./panelStart.ts";

const tab = (id, lastActiveAt, overrides = {}) => ({
  id,
  lastActiveAt,
  url: `https://${id}.example/`,
  title: id,
  customTitle: null,
  favicon: null,
  ...overrides,
});
const visit = (url, visits, lastVisit, overrides = {}) => ({ url, visits, lastVisit, title: "Page title", favicon: null, ...overrides });
const section = (result, id) => result.find((entry) => entry.id === id)?.items;

test("opening a current URL offers page actions with the URL and Markdown title", () => {
  const [section] = currentPageActions({ url: "https://example.com/changelog/0.0.10", title: "Release 0.0.10", customTitle: null });
  assert.equal(section.id, "page");
  assert.deepEqual(
    section.items.map(({ id, title }) => ({ id, title })),
    [
      { id: "copyUrl", title: "Copy Link" },
      { id: "copyUrlAsMarkdown", title: "Copy Markdown Link" },
      { id: "duplicateTab", title: "Duplicate Tab" },
    ],
  );
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
    tab("oldest", 1),
    tab("current", 200),
    tab("blank", 300, { url: "" }),
    tab("third", 30),
    tab("first", 50, { customTitle: "My project", favicon: "project-icon" }),
    tab("fourth", 20),
    tab("second", 40),
  ];
  const result = paletteStart(tabs, [visit("https://docs.example/document/123", 5, 5)], "current");
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["recent", "frequent"],
  );
  const recent = section(result, "recent");
  assert.deepEqual(
    recent.map((item) => item.tabId),
    ["first", "second", "third", "fourth"],
  );
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
  assert.deepEqual(
    frequent.map((item) => item.title),
    ["alpha.example", "beta.example", "gamma.example"],
  );
  assert.equal(frequent[0].favicon, "latest-icon");
  assert.equal(frequent[0].url, "https://www.alpha.example/");
  assert.equal(
    frequent.some((item) => item.title === "delta.example"),
    false,
  );
});

test("frequent links use the latest page origin with its scheme and port", () => {
  const history = [
    visit("https://localhost:8443/old", 2, 10, { favicon: "old" }),
    visit("http://localhost:3000/project?secret=value#section", 4, 20, { favicon: "new" }),
    visit("https://secure.example:9443/path?q=1#heading", 3, 15, { favicon: "secure" }),
  ];
  const frequent = section(paletteStart([], history, "current"), "frequent");
  assert.deepEqual(
    frequent.map(({ title, url, favicon }) => ({ title, url, favicon })),
    [
      { title: "localhost", url: "http://localhost:3000/", favicon: "new" },
      { title: "secure.example", url: "https://secure.example:9443/", favicon: "secure" },
    ],
  );
});

test("frequent sites still show when they're also open as recent tabs", () => {
  const tabs = [tab("current", 9), tab("open", 5, { url: "https://www.open.example/inbox" })];
  const history = [visit("https://open.example/", 9, 9), visit("https://other.example/", 1, 1)];
  const result = paletteStart(tabs, history, "current");
  assert.deepEqual(
    section(result, "frequent").map((item) => item.title),
    ["open.example", "other.example"],
  );
});

test("no tabs or history leaves the idle list empty", () => {
  assert.deepEqual(paletteStart([], [], "current"), []);
});

test("nonweb, internal and malformed history cannot enter frequent sites", () => {
  const history = [
    "bay://settings",
    "chrome://settings",
    "about:blank",
    "file:///private/file.html",
    "ftp://files.example/",
    "javascript:alert(1)",
    "https://",
    "https://:invalid",
  ].map((url) => visit(url, 1000, 1000));
  history.push(visit("https://valid.example/article", 1, 1));
  const frequent = section(paletteStart([], history, "current"), "frequent");
  assert.deepEqual(
    frequent.map((item) => item.url),
    ["https://valid.example/"],
  );
  assert.equal(section(paletteStart([], history.slice(0, -1), "current"), "frequent"), undefined);
});

test("building idle sections leaves caller tab and history arrays unchanged", () => {
  const tabs = Object.freeze([Object.freeze(tab("first", 1)), Object.freeze(tab("second", 2))]);
  const history = Object.freeze([Object.freeze(visit("https://site.example/first", 2, 1)), Object.freeze(visit("https://site.example/second", 3, 2))]);
  const before = structuredClone({ tabs, history });
  const first = paletteStart(tabs, history, "current");
  const second = paletteStart(tabs, history, "current");
  assert.deepEqual({ tabs, history }, before);
  assert.deepEqual(second, first);
});

test("frequent sites scan each history snapshot once while recent tabs stay live", () => {
  let scans = 0;
  const history = new Proxy([visit("https://site.example/page", 2, 10)], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) scans++;
      return Reflect.get(target, key, receiver);
    },
  });
  const first = paletteStart([tab("a", 1)], history, "current");
  for (let i = 0; i < 30; i++) {
    const next = paletteStart([tab("b", i)], history, "current");
    assert.strictEqual(section(next, "frequent"), section(first, "frequent"));
    assert.equal(section(next, "recent")[0].tabId, "b");
  }
  assert.equal(scans, 1);
  const updated = [...history, visit("http://new.example:3000/project", 20, 30, { favicon: "new-icon" })];
  const frequent = section(paletteStart([], updated, "current"), "frequent");
  assert.equal(frequent[0].url, "http://new.example:3000/");
  assert.equal(frequent[0].favicon, "new-icon");
  assert.equal(section(paletteStart([], [], "current"), "frequent"), undefined, "clearing history removes cached sites");
  assert.strictEqual(section(paletteStart([], history, "current"), "frequent"), section(first, "frequent"), "separate history snapshots remain independent");
});

test("new history snapshots reuse unchanged rows' hosts, including rejected URLs", () => {
  let reads = 0;
  const counted = (url) =>
    Object.freeze({
      ...visit(url, 1, 1),
      get url() {
        reads++;
        return url;
      },
    });
  const unchanged = [counted("https://quiet.example/page"), counted("file:///private/page"), counted("https://:invalid")];
  const winners = [visit("https://first.example/", 20, 20), visit("https://second.example/", 15, 15), visit("https://third.example/", 10, 10)];
  paletteStart([], [...winners, ...unchanged], "current");
  const initialReads = reads;
  assert.ok(initialReads > 0);
  for (let i = 0; i < 5; i++) {
    const updated = [{ ...winners[0], visits: 21 + i, lastVisit: 21 + i }, ...winners.slice(1), ...unchanged];
    assert.equal(section(paletteStart([], updated, "current"), "frequent")[0].title, "first.example");
  }
  assert.equal(reads, initialReads, "replacing a snapshot does not parse its unchanged rows again");
});

test("replacement rows update totals, latest origin and favicon without changing older snapshots", () => {
  const old = visit("https://www.site.example:8443/old", 3, 10, { favicon: "old" });
  const other = visit("https://other.example/", 5, 20);
  const first = [old, other];
  assert.equal(section(paletteStart([], first, "current"), "frequent")[0].title, "other.example");
  const next = [visit("http://site.example:3000/new?private=value#part", 4, 30, { favicon: "new" }), old, other];
  assert.deepEqual(section(paletteStart([], next, "current"), "frequent")[0], {
    kind: "page",
    title: "site.example",
    host: "site.example",
    url: "http://site.example:3000/",
    favicon: "new",
  });
  const modified = [{ ...next[0], visits: 1, favicon: "modified" }, other];
  assert.equal(section(paletteStart([], modified, "current"), "frequent")[0].title, "other.example");
  assert.equal(section(paletteStart([], modified, "current"), "frequent")[1].favicon, "modified");
  assert.equal(section(paletteStart([], [old, other], "current"), "frequent")[0].title, "other.example");
  assert.equal(section(paletteStart([], first, "current"), "frequent")[1].favicon, "old");
  assert.deepEqual(paletteStart([], [], "current"), []);
  assert.equal(section(paletteStart([], [other], "current"), "frequent").length, 1);
});

test("host reuse keeps first-seen ranking and latest-page ties for each snapshot", () => {
  const alpha = visit("https://alpha.example/", 4, 10);
  const beta = visit("https://beta.example/", 4, 10);
  const older = visit("https://www.alpha.example:8443/", 2, 5, { favicon: "first" });
  const tied = visit("http://alpha.example:3000/", 2, 5, { favicon: "second" });
  paletteStart([], [alpha, beta, older, tied], "current");
  assert.deepEqual(
    section(paletteStart([], [beta, alpha], "current"), "frequent").map((s) => s.host),
    ["beta.example", "alpha.example"],
  );
  assert.deepEqual(
    section(paletteStart([], [alpha, beta], "current"), "frequent").map((s) => s.host),
    ["alpha.example", "beta.example"],
  );
  assert.equal(section(paletteStart([], [older, tied], "current"), "frequent")[0].url, "https://www.alpha.example:8443/");
  assert.equal(section(paletteStart([], [tied, older], "current"), "frequent")[0].favicon, "second");
});

test("reused hosts preserve credential, IPv6, scheme and port parsing", () => {
  const rows = [
    visit("HTTPS://user:password@WWW.EXAMPLE.COM:0443/path?private=value#hash", 5, 10),
    visit("http://[::1]:8080/path", 4, 10),
    visit("https://www.example.com:9443/recent", 1, 20),
    visit(" https://leading.example/", 100, 100),
  ];
  const expected = [
    { title: "example.com", url: "https://www.example.com:9443/" },
    { title: "[::1]", url: "http://[::1]:8080/" },
  ];
  for (const snapshot of [rows, [...rows], rows.slice(0, -1)]) {
    assert.deepEqual(
      section(paletteStart([], snapshot, "current"), "frequent").map(({ title, url }) => ({ title, url })),
      expected,
    );
  }
  assert.equal(section(paletteStart([], rows.slice(0, 2), "current"), "frequent")[0].url, "https://www.example.com:0443/");
});
