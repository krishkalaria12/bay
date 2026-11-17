// Drives @bay/core's address, IDN, calculator, emoji and suggestion code (and the phone's address helpers) through
// cases its own tests don't reach, so `record-fixtures.mjs input` records them too. Each call only has to run; the
// Rust port is checked against what it returned.
import test from "node:test";

import { calculate, evaluate, formatNumber } from "../../core/src/calculator.ts";
import { cleanUrl } from "../../core/src/cleanUrl.ts";
import { BUILT_IN_ENGINES, parseSuggestions, suggestRequestUrl } from "../../core/src/engines.ts";
import { findEmoji } from "../../core/src/emoji.ts";
import { displayHost, hostSpoofReason, punycodeDecode, punycodeEncode } from "../../core/src/idn.ts";
import { classifyPaste, fixupUrl, hostOf, resolveInput, urlForDisplay } from "../../core/src/input.ts";
import { matchQuickCreate } from "../../core/src/quickCreate.ts";
import { buildSuggestions, displayUrl } from "../../core/src/suggest.ts";
import { engineFor, isWebURL, resolveAddress, siteName } from "../../../apps/mobile/src/browser/address.ts";

const ADDRESSES = [
  "example.com",
  "Example.COM/Path?q=1#x",
  "www.example.com",
  "localhost:3000",
  "127.0.0.1",
  "192.168.1.1:8080/admin",
  "[::1]:8080",
  "intranet.local",
  "printer.lan/status",
  "foo.notatld",
  "foo.notatld/path",
  "foo.notatld:8080",
  "xn--bcher-kva.de",
  "bücher.de",
  "my site.com",
  "what is rust",
  "/Users/me/file.txt",
  "/Users/me/my file.txt",
  "//double",
  "about:blank",
  "about:settings",
  "about:srcdoc",
  "data:text/html,hi",
  "mailto:me@example.com",
  "tel:+123",
  "view-source:https://example.com",
  "chrome://settings",
  "bay://history",
  "bay:bookmarks",
  "bay://",
  "http://example.com",
  "https://user:pass@example.com:443/a b",
  "ftp://files.example.org/x",
  "spotify:track:123",
  "custom-app://open/thing",
  "javascript:alert(1)",
  "file:///etc/hosts",
  "example.com.",
  "a.b.c.d.example.co.uk/deep/path",
  "12.34",
  "1.2.3",
  "?just search",
  "?",
  "  spaced.com  ",
  "github.com/anthropics",
  "xn--80ak6aa92e.com",
  "xn--pple-43d.com",
  "xn--ggle-0nda.com",
  "xn--mnchen-3ya.de",
  "xn--wgbh1c",
  "xn--fiqs8s",
  "xn--55qx5d.cn",
  "xn--80aswg.xn--p1ai",
  "xn--invalid-.com",
  "xn--.com",
  "XN--BCHER-KVA.DE",
];

const HOSTS = [
  "xn--bcher-kva.de",
  "xn--80ak6aa92e.com",
  "xn--pple-43d.com",
  "xn--ggle-0nda.com",
  "xn--mnchen-3ya.de",
  "xn--fiqs8s",
  "xn--55qx5d.cn",
  "xn--80aswg.xn--p1ai",
  "xn--e1afmkfd.xn--p1ai",
  "xn--9n2bp8q.com",
  "xn--hxajbheg2az3al.gr",
  "xn--mgbh0fb.xn--mgbaam7a8h",
  "xn--4gbrim.xn----ymcbaaajlc6dj7bxne2c.xn--wgbh1c",
  "xn--fsq.com",
  "xn--tst-qla.example",
  "xn--ls8h.la",
  "xn--i-7iq.ws",
  "xn--n3h.com",
  "xn--strae-oqa.de",
  "xn--nxasmq6b.com",
  "xn--caf-dma.fr",
  "www.xn--caf-dma.fr",
  "xn--80adxhks.com",
  "xn--90ais",
  "xn--microsft-p5a.com",
  "xn--paypa-r7a.com",
  "xn--o-5ya.com",
  "xn--bcher-kva.xn--bcher-kva",
];

test("addresses", () => {
  for (const address of ADDRESSES) {
    fixupUrl(address);
    resolveInput(address);
    classifyPaste(address);
    hostOf(address);
    resolveAddress(address, engineFor("duckduckgo"));
    resolveAddress(address, engineFor("custom", "https://search.example/find?q=%s"));
    isWebURL(address);
    siteName(address);

    const url = fixupUrl(address);

    if (url) {
      urlForDisplay(url);
      displayUrl(url);
    }
  }

  for (const host of HOSTS) {
    displayHost(host);
    hostSpoofReason(host);
    urlForDisplay(`https://${host}/path?x=1`);
  }

  for (const word of ["münchen", "bücher", "мама", "中国", "ü", "abc", "a-b"]) punycodeEncode(word);

  for (const word of ["mnchen-3ya", "bcher-kva", "80aswg", "fiqs8s", "zzzz", "-", "abc-"]) punycodeDecode(word);

  for (const url of [
    "https://example.com/?utm_source=x&id=1&fbclid=y#top",
    "https://www.youtube.com/watch?v=abc&si=xyz&t=10",
    "https://www.amazon.com/dp/B0?ref_=x&pd_rd_w=1&keep=1",
    "https://x.com/user/status/1?s=20&t=abc",
    "https://example.com/?UTM_Medium=a",
    "https://example.com/?%75tm_source=a",
    "https://example.com/?a=1&&b=2&utm_x=",
    "ftp://example.com/?utm_source=x",
    "not a url?utm_source=x",
    "https://example.com/no-query",
  ]) {
    cleanUrl(url);
  }
});

test("calculator", () => {
  for (const expression of [
    "2+2",
    "= 2 + 2 =",
    "2+2=?",
    "10 / 3",
    "2^10",
    "2**10",
    "-3^2",
    "5!",
    "171!",
    "50%",
    "200 * 15%",
    "10 % 3",
    "17 mod 5",
    "20% of 50",
    "3 x 4",
    "2(3+4)",
    "2pi",
    "sqrt(16)",
    "sin(90°)",
    "sin(90 deg)",
    "log(100)",
    "log(8, 2)",
    "ln(e)",
    "max(1, 5, 3)",
    "1,000,000 + 1",
    "1,5 + 1",
    "0.1 + 0.2",
    "1e21 * 10",
    "1/3e12",
    "0.0000000001",
    "123456789012345",
    "1/0",
    "2026-11-17",
    "1.2.3",
    "pi",
    "e",
    "tau",
    "π × 2",
    "6 ÷ 2",
    "5 − 3",
    "abc",
    "",
    "(1+2",
    "12 km to miles",
    "5 feet in cm",
    "100 f to c",
    "32 fahrenheit to celsius",
    "0 c to k",
    "1 GB to MB",
    "1 MB to mb",
    "10 m² to ft²",
    "1 hour to minutes",
    "3 cups to ml",
    "60 mph to km/h",
    "1 kg to lb",
    "1 lightyear to km",
    "2 km to kg",
  ]) {
    calculate(expression);
    evaluate(expression);
  }

  for (const value of [0, 1, -1, 0.1 + 0.2, 1 / 3, 123456789.12345679, 1e21, 1.5e-10, 2.5e-7, 1e-6, -0.000001234, 1e300, 1.2345678901234567e19]) {
    formatNumber(value);
    formatNumber(value, 9);
  }
});

test("emoji and quick create", () => {
  for (const query of [
    "emoji heart",
    "emoji red heart",
    "Emoji  smile",
    "emoji cafe",
    "emoji café",
    "emoji thumbs up",
    "emoji flag",
    "emoji zzzz",
    "emoji",
    "heart",
    "emoji 100",
    "emoji face with",
  ]) {
    findEmoji(query);
    findEmoji(query, 2);
  }

  for (const query of ["new", "new doc", "create sheet", "new  google   doc", "new ticket", "new zzz", "newdoc", "New Figma", "create"])
    matchQuickCreate(query);
});

test("suggestions as the phone asks for them", () => {
  const now = Date.UTC(2026, 10, 17, 12);

  const history = [
    { url: "https://github.com/anthropics/claude", title: "Claude on GitHub", favicon: null, visits: 12, lastVisit: now - 3_600_000 },
    { url: "https://github.com/", title: "GitHub", favicon: "file:///gh.png", visits: 40, lastVisit: now - 60_000 },
    { url: "https://dash.cloudflare.com/overview", title: "Cloudflare dashboard", favicon: null, visits: 5, lastVisit: now - 86_400_000 },
    { url: "https://dashboard.render.com/", title: "Render", favicon: null, visits: 2, lastVisit: now - 5 * 86_400_000 },
    { url: "https://news.ycombinator.com/item?id=1", title: "Rust is great | Hacker News", favicon: null, visits: 1, lastVisit: now - 40 * 86_400_000 },
    {
      url: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      title: "Rust (programming language) - Wikipedia",
      favicon: null,
      visits: 3,
      lastVisit: now - 2 * 86_400_000,
    },
    { url: "https://docs.rs/serde/latest/serde/#derive", title: "serde - Rust", favicon: null, visits: 9, lastVisit: now - 7_200_000 },
  ];

  const bookmarks = [
    { url: "https://docs.rs/", title: "Docs.rs", favicon: null },
    { url: "https://github.com/", title: "GitHub", favicon: null },
  ];

  const tabs = [
    { id: "t1", url: "https://github.com/anthropics/claude", title: "Claude on GitHub", favicon: null },
    { id: "t2", url: "https://example.com/", title: "Example", favicon: null },
    { id: "t3", url: "", title: "", favicon: null },
  ];

  const cleaned = [{ id: "a1", url: "https://archived.example/page", title: "An archived page", favicon: null, closedAt: now - 86_400_000 }];
  const source = { tabs, history, bookmarks, cleaned };

  for (const engine of [BUILT_IN_ENGINES[0]!, engineFor("duckduckgo"), engineFor("custom", "https://search.example/?q=%s")]) {
    for (const query of [
      "g",
      "gi",
      "git",
      "github",
      "github.com/an",
      "dash",
      "rust",
      "rust lang",
      "serde derive",
      "docs",
      "example",
      "archived",
      "2+2",
      "12 km to miles",
      "emoji heart",
      "new doc",
      "?github",
      "? ",
      "localhost:3000",
      "what is rust",
      "  ",
      "hacker",
      "wiki rust",
    ]) {
      buildSuggestions(query, source, {
        engine,
        remote: ["github copilot", "Github", "github desktop", " ", "github actions", "github pages"],
        limit: 7,
        currentTabId: "t2",
        currentUrl: "https://example.com/",
        now,
      });
      buildSuggestions(query, { tabs: [], history: [] }, { engine, limit: 7, now });
    }
  }

  for (const query of ["rust", "github"]) suggestRequestUrl(BUILT_IN_ENGINES[0]!, query);

  for (const body of [["q", ["a", " b ", "", 3]], ["q"], {}, null, ["q", "not a list"]]) parseSuggestions(body);
});
