// Omnibox ranking and inline completion, and the suggestion fetcher's race with typing.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BUILT_IN_ENGINES, engineById } from "./engines.ts";
import { buildSuggestions, type Suggestion } from "./suggest.ts";
import { createSuggestFetcher, type FetchLike } from "./suggestFetcher.ts";

const now = Date.UTC(2026, 8, 24);
const DAY = 86_400_000;
const history = [
  { url: "https://x.com/home", title: "(1) Home / X", favicon: null, visits: 40, lastVisit: now - 1000 },
  { url: "https://x.com/notifications", title: "Notifications / X", favicon: null, visits: 5, lastVisit: now - 5000 },
  { url: "https://www.xing.com/", title: "XING", favicon: null, visits: 1, lastVisit: now - DAY * 10 },
  { url: "https://github.com/", title: "GitHub", favicon: null, visits: 12, lastVisit: now - 2000 },
];

function rows(items: Suggestion[]): string[] {
  return items.map((i) => {
    switch (i.kind) {
      case "page":
        return i.tabId ? `tab:${i.url}` : i.url;
      case "search":
        return `${i.suggested ? "suggest" : "search"}:${i.query}`;
      case "calc":
        return `calc:${i.value}`;
      case "emoji":
        return `emoji:${i.value}`;
      case "action":
        return `action:${i.id}`;
      case "create":
        return `create:${i.id}`;
    }
  });
}

test("inline completion never takes a long query URL: 'm' completes to the host", () => {
  const signIn =
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F&service=mail&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin#inbox";
  const hist = [
    {
      url: "https://mail.google.com/mail/u/0/?service=mail&continue=" + encodeURIComponent(signIn) + "#inbox",
      title: "Inbox - me@gmail.com - Gmail",
      favicon: "gmail.ico",
      visits: 50,
      lastVisit: now - 1000,
    },
    { url: signIn, title: "Sign in - Google Accounts", favicon: null, visits: 3, lastVisit: now - 2000 },
  ];
  const m = buildSuggestions("m", { tabs: [], history: hist }, { now });
  assert.equal(m.completion, "ail.google.com");
  assert.deepEqual(m.items[0], { kind: "page", url: "https://mail.google.com/", title: "", favicon: "gmail.ico" });
  assert.ok(rows(m.items).includes(hist[0]!.url));
  const a = buildSuggestions("a", { tabs: [], history: hist }, { now });
  assert.equal(a.completion, "ccounts.google.com");
  assert.equal(buildSuggestions("mail.google.com/m", { tabs: [], history: hist }, { now }).completion, "");
  assert.equal(buildSuggestions("x.com/h", { tabs: [], history }, { now }).completion, "ome");
});

test("free text puts a search first-class and never autocompletes", () => {
  const { items, completion } = buildSuggestions("git hub", { tabs: [], history }, { now });
  assert.equal(completion, "");
  assert.equal(items[0]?.kind, "search");
});

test("open tabs are marked so the bar can switch to them, except the bar's own tab", () => {
  const tabs = [{ id: "t1", url: "https://github.com/", title: "GitHub", favicon: null }];
  const { items } = buildSuggestions("gith", { tabs, history }, { now });
  assert.equal(items[0]?.kind === "page" && items[0].tabId, "t1");
  const own = buildSuggestions("gith", { tabs, history }, { now, currentTabId: "t1" });
  assert.equal(own.items[0]?.kind === "page" && own.items[0].tabId, undefined);
});

test("cleaned up tabs are found and marked so the bar can restore them", () => {
  const cleaned = [{ id: "c1", url: "https://linear.app/team/issue/BAY-12", title: "BAY-12 Archive search", favicon: null, closedAt: now - DAY }];
  const { items } = buildSuggestions("archive", { tabs: [], history, cleaned }, { now });
  const row = items.find((i) => i.kind === "page" && i.url === cleaned[0]!.url);
  assert.equal(row?.kind === "page" && row.cleanedId, "c1");
  // Its page in history is the same row, restored rather than opened.
  const visited = buildSuggestions(
    "notif",
    { tabs: [], history, cleaned: [{ id: "c2", url: "https://x.com/notifications", title: "Notifications / X", favicon: null, closedAt: now }] },
    { now },
  );
  const rowsFor = visited.items.filter((i) => i.kind === "page" && i.url === "https://x.com/notifications");
  assert.equal(rowsFor.length, 1);
  assert.equal(rowsFor[0]?.kind === "page" && rowsFor[0].cleanedId, "c2");
});

test("an open tab wins over a cleaned up copy of its page, and the newest cleaned entry wins over older ones", () => {
  const tabs = [{ id: "t1", url: "https://github.com/", title: "GitHub", favicon: null }];
  const cleaned = [
    { id: "new", url: "https://github.com/", title: "GitHub", favicon: null, closedAt: now },
    { id: "docs-new", url: "https://docs.rs/", title: "Docs.rs", favicon: null, closedAt: now },
    { id: "docs-old", url: "https://docs.rs/", title: "Docs.rs", favicon: null, closedAt: now - DAY },
  ];
  const gh = buildSuggestions("gith", { tabs, history, cleaned }, { now }).items[0];
  assert.equal(gh?.kind === "page" && gh.tabId, "t1");
  assert.equal(gh?.kind === "page" && gh.cleanedId, undefined);
  const docs = buildSuggestions("docs", { tabs, history, cleaned }, { now }).items.filter((i) => i.kind === "page" && i.url === "https://docs.rs/");
  assert.deepEqual(
    docs.map((i) => i.kind === "page" && i.cleanedId),
    ["docs-new"],
  );
  // The bar's own tab isn't offered, so its page's cleaned copy is.
  const own = buildSuggestions("gith", { tabs, history, cleaned }, { now, currentTabId: "t1" }).items[0];
  assert.equal(own?.kind === "page" && own.cleanedId, "new");
});

test("frecency: frequent + recent beats old, and multi-word queries match words", () => {
  const hist = [
    { url: "https://a.com/docs", title: "Rust docs", favicon: null, visits: 2, lastVisit: now - DAY * 60 },
    { url: "https://b.com/docs", title: "Rust docs", favicon: null, visits: 20, lastVisit: now - DAY },
  ];
  const { items } = buildSuggestions("docs rust", { tabs: [], history: hist }, { now });
  assert.deepEqual(rows(items), ["search:docs rust", "https://b.com/docs", "https://a.com/docs"]);
});

const google = engineById(BUILT_IN_ENGINES, "google");
const flush = () => new Promise((r) => setImmediate(r));

function fakeFetch(respond: (url: string) => unknown = (url) => [decodeURIComponent(url.split("q=").at(-1)!), ["a", "b"]]) {
  const calls: { url: string; signal: AbortSignal }[] = [];
  const fetch: FetchLike = (url, { signal }) => {
    calls.push({ url, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      queueMicrotask(() => resolve({ ok: true, text: async () => JSON.stringify(respond(url)) }));
    });
  };
  return { fetch, calls };
}

test("a newer request aborts the one in flight, which never answers", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { fetch, calls } = fakeFetch();
    const results: string[] = [];
    const fetcher = createSuggestFetcher({ fetch, delay: 10 });
    fetcher.request(google, "old", () => results.push("old"));
    mock.timers.tick(10);
    assert.equal(calls.length, 1);
    fetcher.request(google, "new", () => results.push("new"));
    assert.equal(calls[0]!.signal.aborted, true);
    mock.timers.tick(10);
    await flush();
    assert.deepEqual(results, ["new"]);
  } finally {
    mock.timers.reset();
  }
});

test("remoteFirst lists the engine's suggestions before matching pages, the best one aside", () => {
  const remote = Array.from({ length: 10 }, (_, i) => `what is the best ${i}`);
  const hist = [
    { url: "https://blog.example/what-is-the-best-editor", title: "What is the best editor", favicon: null, visits: 2, lastVisit: now - 1000 },
    { url: "https://news.example/what-is-the-best-phone", title: "What is the best phone", favicon: null, visits: 1, lastVisit: now - 5000 },
  ];
  const list = rows(buildSuggestions("what is the best", { tabs: [], history: hist }, { now, remote, limit: 20, remoteLimit: 10, remoteFirst: true }).items);
  assert.equal(list.filter((r) => r.startsWith("suggest:")).length, 10);
  assert.equal(list[0], "https://blog.example/what-is-the-best-editor");
  assert.ok(list.indexOf("suggest:what is the best 9") < list.indexOf("https://news.example/what-is-the-best-phone"));
});

test("remoteLimit raises how many engine suggestions show, history pages still come first", () => {
  const remote = Array.from({ length: 10 }, (_, i) => `what is the best ${i}`);
  const hist = [{ url: "https://blog.example/what-is-the-best-editor", title: "What is the best editor", favicon: null, visits: 2, lastVisit: now - 1000 }];
  const short = rows(buildSuggestions("what is the best", { tabs: [], history: hist }, { now, remote }).items);
  assert.equal(short.filter((r) => r.startsWith("suggest:")).length, 4);
  const long = rows(buildSuggestions("what is the best", { tabs: [], history: hist }, { now, remote, limit: 12, remoteLimit: 8 }).items);
  assert.equal(long.filter((r) => r.startsWith("suggest:")).length, 8);
  assert.ok(long.includes("https://blog.example/what-is-the-best-editor"));
  assert.ok(long.indexOf("https://blog.example/what-is-the-best-editor") < long.indexOf("suggest:what is the best 0"));
  assert.equal(long.length, 10);
});

test("a word that starts sites' addresses lists each site once, ahead of the engine's suggestions and their deeper pages", () => {
  const remote = Array.from({ length: 10 }, (_, i) => `dash ${i}`);
  const hist = [
    { url: "https://dash.cloudflare.com/3bd6d50d63c2/home", title: "Cloudflare Dashboard", favicon: null, visits: 30, lastVisit: now - 1000 },
    { url: "https://dash.cloudflare.com/login", title: "Cloudflare Dashboard", favicon: null, visits: 4, lastVisit: now - 9000 },
    { url: "https://dashboard.render.com/", title: "Render Dashboard", favicon: null, visits: 3, lastVisit: now - DAY },
    { url: "https://dashboard.render.com/web/srv-d2stabn5r7bs73bnm9p0/env", title: "lately · Render", favicon: null, visits: 9, lastVisit: now - 2000 },
    { url: "https://dashboard.convex.dev/t/me/app", title: "Convex Dashboard", favicon: null, visits: 2, lastVisit: now - DAY * 2 },
    { url: "https://example.com/dashboards", title: "Example", favicon: null, visits: 1, lastVisit: now - DAY * 3 },
  ];
  const list = rows(buildSuggestions("dash", { tabs: [], history: hist }, { now, remote, limit: 20, remoteLimit: 10, remoteFirst: true }).items);
  const firstSuggest = list.indexOf("suggest:dash 0");
  // The best site completes inline and comes first; the others follow the search row, before the engine's suggestions.
  assert.equal(list[0], "https://dash.cloudflare.com/");
  for (const site of ["https://dashboard.render.com/", "https://dashboard.convex.dev/"]) {
    assert.ok(list.includes(site), site);
    assert.ok(list.indexOf(site) < firstSuggest, site);
  }
  assert.ok(list.indexOf("https://dashboard.render.com/web/srv-d2stabn5r7bs73bnm9p0/env") > firstSuggest);
  // "com" names no site: the domain's end isn't one of its names.
  const com = rows(buildSuggestions("com", { tabs: [], history: hist }, { now, remote: [], limit: 20 }).items);
  assert.ok(!com.includes("https://dashboard.convex.dev/"));
});
