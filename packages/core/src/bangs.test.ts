import assert from "node:assert/strict";
import { test } from "node:test";
import { BANG_LIST, BANG_LIST_UNICODE } from "./bangList.ts";
import {
  bangDocument,
  bangTable,
  checkedBangTable,
  customBangTable,
  escapeSearchTerms,
  fillBangTemplate,
  findBang,
  joinBangTables,
  parseLooseJson,
  readBangDocument,
  slimBangs,
  staysOnSite,
} from "./bangs.ts";
import { buildSuggestions } from "./suggest.ts";

const filler = Array.from({ length: 1000 }, (_, i) => ({ s: `Site ${i}`, ts: [`site${i}`], u: `https://site${i}.example/?q={searchTerms}` }));

function heliumFile(entries: unknown[]): string {
  const body = JSON.stringify([...entries, ...filler], null, 1).replace(/"\n(\s*)([\]}])/g, '",\n$1$2');
  return `// Generated at 2026-10-14T11:11:02.825Z\n// MIT License\n//\n\n${body}\n`;
}

const fixture = slimBangs(
  heliumFile([
    { s: "GitHub", ts: ["gh", "git", "github"], u: "https://github.com/search?q={searchTerms}" },
    { s: "GitHub Repo", ts: ["ghr"], f: 1, u: "https://github.com/{searchTerms}" },
    { s: "Wikipedia", ts: ["w", "wiki"], u: "https://wikipedia.org/w/index.php?search={searchTerms}" },
    { s: "YouTube", ts: ["yt", "ют"], u: "https://www.youtube.com/results?search_query={searchTerms}" },
    { s: "Zig", ts: ["zig"], u: "https://ziglang.org/documentation/master/std/#?{searchTerms}" },
    { s: "Gmail", ts: ["gmail"], u: "https://mail.google.com/mail/u/0/#search/{searchTerms}" },
    { s: "T3 Chat", ts: ["t3"], u: "https://www.t3.chat/new?q={searchTerms}", sc: "ai" },
    { s: "Microsoft Copilot", ts: ["copilot"], u: "https://copilot.microsoft.com/?q={searchTerms}" },
    { s: "DuckDuckGo AI Chat", ts: ["ddg-chat"], u: "https://duckduckgo.com/?q={searchTerms}&ia=chat&bang=true" },
    { s: "Not a web page", ts: ["ftp"], u: "ftp://example.com/{searchTerms}" },
    { s: "Read the Docs", ts: ["rtfd"], u: "https://{searchTerms}.rtfd.io/" },
    { s: "hypestat", ts: ["hypestat"], u: "https://www.{searchTerms}.hypestat.com/" },
    { s: "No slash", ts: ["noslash"], u: "https://example.com{searchTerms}" },
    { s: "Port", ts: ["port"], u: "https://example.com:{searchTerms}/" },
    { s: "User", ts: ["user"], u: "https://{searchTerms}@example.com/" },
    { s: "Taken", ts: ["gh"], u: "https://taken.example/?q={searchTerms}" },
  ]),
)!;
const table = bangTable(fixture);
const url = (text: string) => {
  const match = findBang(text, table);
  return match && match.url;
};

test("a bang at the start or the end of the text picks the site, any case", () => {
  assert.equal(url("!gh react"), "https://github.com/search?q=react");
  assert.equal(url("react !w"), "https://wikipedia.org/w/index.php?search=react");
  assert.equal(url("!GH react hooks"), "https://github.com/search?q=react+hooks");
  assert.equal(url("  react   hooks   !Wiki "), "https://wikipedia.org/w/index.php?search=react+hooks");
  assert.equal(url("!ют cats"), "https://www.youtube.com/results?search_query=cats");
  assert.deepEqual(findBang("!gh react", table)?.bang, {
    trigger: "gh",
    name: "GitHub",
    template: "https://github.com/search?q={searchTerms}",
    home: "https://github.com/",
  });
});

test("a bare bang opens the site's home", () => {
  assert.equal(url("!yt"), "https://www.youtube.com/");
  assert.equal(url("  !W  "), "https://wikipedia.org/");
});

test("an unknown bang, a lone '!' or a '!' inside a word is no bang", () => {
  for (const text of [
    "!nope react",
    "react !nope",
    "hello!",
    "wow ! nice",
    "!",
    "! gh react",
    "hi!gh",
    "say !gh in the middle",
    "example.com/!gh",
    "?!gh react",
    "a!w",
  ]) {
    assert.equal(findBang(text, table), null, text);
  }
  assert.equal(findBang("!gh react", null), null);
});

test("the first matching end wins, and the other bang stays in the query", () => {
  assert.equal(url("!gh react !w"), "https://github.com/search?q=react+!w");
  assert.equal(url("!nope react !w"), "https://wikipedia.org/w/index.php?search=!nope+react");
});

test("terms after '?' are escaped as a query parameter, with '+' for spaces, like Chrome's search engines", () => {
  assert.equal(url("!gh a+b & c/d #x 100%"), "https://github.com/search?q=a%2Bb+%26+c%2Fd+%23x+100%25");
  assert.equal(url("!gh 日本 語"), "https://github.com/search?q=%E6%97%A5%E6%9C%AC+%E8%AA%9E");
  assert.equal(url("!gh it's (ok)*!~"), "https://github.com/search?q=it's+(ok)*!~");
  assert.equal(url("!zig std.mem a b"), "https://ziglang.org/documentation/master/std/#?std.mem+a+b");
});

test("terms in the path keep '/' and escape what would end the path, spaces as %20", () => {
  assert.equal(url("!ghr facebook/react"), "https://github.com/facebook/react");
  assert.equal(url("!ghr a b?c#d%e"), "https://github.com/a%20b%3Fc%23d%25e");
  assert.equal(url("!gmail from:me"), "https://mail.google.com/mail/u/0/#search/from%3Ame");
  assert.equal(escapeSearchTerms("é ü", false), "%C3%A9%20%C3%BC");
  assert.equal(escapeSearchTerms("a\ud800b", true), "a%EF%BF%BDb");
  assert.equal(fillBangTemplate("https://a.example/{searchTerms}/x?q={searchTerms}", "p q"), "https://a.example/p%20q/x?q=p%20q");
});

test("a template with the terms in its scheme, host, port or user is left out, so the query can't pick the host", () => {
  for (const t of ["rtfd", "hypestat", "noslash", "port", "user"]) assert.equal(table.get(t), undefined, t);
  for (const text of [
    "!rtfd evil.example/",
    "!hypestat @evil.example/",
    "!rtfd evil.example#",
    "!rtfd evil.example\\",
    "!hypestat //evil.example",
    "!rtfd evil.example%2F",
    "!rtfd",
    "!noslash @evil.example",
  ]) {
    assert.equal(findBang(text, table), null, text);
  }
  const stored = bangTable("rtfd\tRead the Docs\t{s}.rtfd.io/\nhs\thypestat\twww.{s}.hypestat.com/\nus\tUser\t{s}@example.com/");
  for (const t of ["rtfd", "hs", "us"]) assert.equal(stored.get(t), undefined, t);
});

test("the resolved URL must keep the template's scheme, host and port", () => {
  assert.ok(staysOnSite("https://github.com/search?q=a", "https://github.com/search?q={searchTerms}"));
  assert.ok(staysOnSite("https://GitHub.com/a", "https://github.com/{searchTerms}"));
  assert.ok(staysOnSite("https://github.com\\@evil.example/", "https://github.com/{searchTerms}"));
  for (const url of [
    "https://github.com@evil.example/",
    "https://evil.example/github.com/",
    "http://github.com/a",
    "https://github.com:444/a",
    "https://github.com.evil.example/",
    "https://github.com/a\tb",
    "https://github.com/a\nb",
  ]) {
    assert.ok(!staysOnSite(url, "https://github.com/{searchTerms}"), url);
  }
  const sneaky = { size: 1, get: () => ({ trigger: "x", name: "X", template: "https://x.example{searchTerms}", home: "https://x.example/" }) };
  assert.equal(findBang("!x @evil.example", sneaky), null);
  assert.equal(findBang("!x", sneaky), null);
});

test("'?' forces a plain search even with a bang at either end", () => {
  for (const text of ["?!gh react", "?!gh react !w", "? react !w", "  ?react !w"]) assert.equal(findBang(text, table), null, text);
});

test("templates that aren't web pages are left out; every other bang stays, and a trigger keeps its first site", () => {
  assert.equal(table.get("ftp"), undefined);
  assert.equal(table.get("t3")?.name, "T3 Chat");
  assert.equal(url("!copilot hi"), "https://copilot.microsoft.com/?q=hi");
  assert.equal(table.get("gh")?.name, "GitHub");
});

test("Helium's file format: comments, trailing commas and '//' inside strings", () => {
  assert.deepEqual(parseLooseJson('// head\n[\n {"u": "https://a//b", /* c */ "ts": ["x",],},\n // tail\n]\n'), [{ u: "https://a//b", ts: ["x"] }]);
  assert.deepEqual(parseLooseJson('["a\\\\", "b,]", "c\\"//"]'), ["a\\", "b,]", 'c"//']);
});

test("a stored list is checked whole: every line valid, enough of them, the common triggers there, and not too big", () => {
  assert.ok(checkedBangTable(fixture));
  const broken = Array.from({ length: 1200 }, (_, i) => `bad${i}\tBroken\thttps://bad host/`).join("\n");
  assert.equal(checkedBangTable(broken), null);
  assert.equal(checkedBangTable(`${fixture}\nbad\tBroken\thttps://bad host/`), null);
  assert.equal(checkedBangTable(`${fixture}\nbad\tBroken`), null);
  assert.equal(checkedBangTable(`${fixture}\nbad\tBroken\tx.example/{s}\textra`), null);
  assert.equal(
    checkedBangTable(
      fixture
        .split("\n")
        .filter((l) => !l.startsWith("yt "))
        .join("\n"),
    ),
    null,
  );
  assert.equal(checkedBangTable(fixture.split("\n").slice(0, 900).join("\n")), null);
  assert.equal(checkedBangTable(`${fixture}\n${"x".repeat(4_000_000)}\tBig\tbig.example/{s}`), null);
});

test("the stored document carries its ETag with the list it belongs to", () => {
  const doc = bangDocument('"v2"', fixture);
  assert.equal(readBangDocument(doc)?.etag, '"v2"');
  assert.equal(readBangDocument(doc)?.table.get("gh")?.name, "GitHub");
  assert.equal(readBangDocument(bangDocument(null, fixture))?.etag, null);
  for (const bad of [null, "", fixture, doc.slice(0, 2000), `bay-bangs 2\t"v2"\n${fixture}`, `bay-bangs 1\t"v2"\tx\n${fixture}`])
    assert.equal(readBangDocument(bad), null);
});

test("a broken, empty or tiny response is not a bang list", () => {
  for (const body of ["", "<html>oops</html>", "{}", "[]", '[{"s":"A","ts":["a"],"u":"https://a.example/{searchTerms}"}]', heliumFile([]).slice(0, 5000)]) {
    assert.equal(slimBangs(body), null, body.slice(0, 40));
  }
});

test("the bundled list has the common bangs", () => {
  // Keep the main catalog ASCII so Hermes can compile it as a compact string.
  // eslint-disable-next-line no-control-regex
  assert.match(BANG_LIST, /^[\x00-\x7f]*$/);
  const bundled = joinBangTables([bangTable(BANG_LIST), bangTable(BANG_LIST_UNICODE)]);
  assert.ok(bundled.size > 13000, String(bundled.size));
  assert.equal(findBang("!ют cats", bundled)!.url, "https://www.youtube.com/results?search_query=cats");
  assert.equal(findBang("!gh react", bundled)!.url, "https://github.com/search?q=react");
  assert.equal(findBang("react !w", bundled)!.url, "https://wikipedia.org/w/index.php?search=react");
  assert.equal(findBang("!yt", bundled)!.url, "https://www.youtube.com/");
  assert.equal(bundled.get("t3")?.name, "T3 Chat");
});

test("the command bar's top row is the bang's search, then the site's pages from history", () => {
  const source = {
    tabs: [],
    history: [
      { url: "https://github.com/facebook/react", title: "facebook/react", favicon: null, visits: 9, lastVisit: 1 },
      { url: "https://react.dev/", title: "React", favicon: null, visits: 30, lastVisit: 1 },
    ],
  };
  const result = buildSuggestions("!gh react", source, { now: 2, bangs: table, remote: ["react native"] });
  assert.deepEqual(result.items, [
    { kind: "search", query: "react", url: "https://github.com/search?q=react", engine: "GitHub", bang: true },
    { kind: "page", url: "https://github.com/facebook/react", title: "facebook/react", favicon: null, visited: true },
  ]);
  assert.equal(result.completion, "");
  assert.deepEqual(buildSuggestions("!yt", source, { bangs: table }).items, [
    { kind: "page", url: "https://www.youtube.com/", title: "YouTube", favicon: null },
  ]);
  assert.equal(buildSuggestions("hello!", source, { bangs: table }).items[0]?.kind, "search");
  assert.equal(
    buildSuggestions("!gh react", source, { bangs: null }).items.some((s) => s.kind === "search" && s.bang),
    false,
  );
  const scoped = buildSuggestions("!gh react", source, { bangs: table, scope: { kind: "site", name: "X", host: "x.com", url: "https://x.com/search?q=%s" } });
  assert.equal(scoped.items[0]?.kind === "search" && scoped.items[0].url, "https://x.com/search?q=!gh%20react");
});

test("configured search shortcuts also supply bangs and override bundled destinations", () => {
  const custom = customBangTable([
    { name: "Work GitHub", keyword: "gh", url: "https://github.work.example/search?q=%s" },
    { name: "Docs", keyword: "!docs", url: "https://docs.example/%s" },
  ]);
  const combined = joinBangTables([custom, table]);
  assert.equal(findBang("!gh react hooks", combined)?.url, "https://github.work.example/search?q=react+hooks");
  assert.equal(findBang("!docs api/v2", combined)?.url, "https://docs.example/api/v2");
  assert.equal(findBang("!w react", combined)?.bang.name, "Wikipedia");
  assert.equal(findBang("!gh", combined)?.url, "https://github.work.example/");
});

test("configured bangs reject templates whose query controls the destination host", () => {
  const invalid = customBangTable([
    { name: "Bad host", keyword: "gh", url: "https://%s.example/" },
    { name: "Bad scheme", keyword: "script", url: "javascript:alert('%s')" },
    { name: "Bad trigger", keyword: "bad!", url: "https://example.com/?q=%s" },
    { name: "No terms", keyword: "empty", url: "https://example.com/" },
  ]);
  assert.equal(invalid.size, 0);
  assert.equal(findBang("!gh react", joinBangTables([invalid, table]))?.url, "https://github.com/search?q=react");
});
