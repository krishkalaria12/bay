import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as urlmatch from "../src/urlmatch.ts";
import { build, defaultUrl, Meta, parseMeta, urlRuns } from "../src/userscript.ts";
import { Store } from "../src/scripts_store.ts";
import { main } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

const CHROMIUM_URL_CASES: Array<[string, string, boolean]> = [
  ["https://example.com/?q=a?b", "https://example.com/?q=a?b", true],
  ["http://*/*", "http://google.com/", true],
  ["http://*/*", "http://yahoo.com/", true],
  ["http://*/*", "http://google.com/foo", true],
  ["http://*/*", "https://google.com/", false],
  ["http://*/*", "http://74.125.127.100/search", true],
  ["https://*/foo*", "https://www.google.com/foo", true],
  ["https://*/foo*", "https://www.google.com/foobar", true],
  ["https://*/foo*", "http://www.google.com/foo", false],
  ["https://*/foo*", "https://www.google.com/", false],
  ["http://*.google.com/foo*bar", "http://google.com/foobar", true],
  ["http://*.google.com/foo*bar", "http://www.google.com/foobar", true],
  ["http://*.google.com/foo*bar", "http://www.google.com/foo?bar", true],
  ["http://*.google.com/foo*bar", "http://wwwgoogle.com/foobar", false],
  ["http://*.google.com/foo*bar", "http://yahoo.com/foobar", false],
  ["file:///foo?bar\\*baz", "file:///foo?bar\\hellobaz", true],
  ["file:///foo?bar\\*baz", "file:///fooXbar\\hellobaz", false],
  ["http://127.0.0.1/*", "http://127.0.0.1/", true],
  ["*://*/*", "http://127.0.0.1/", true],
  ["*://*/*", "file:///foo/bar", false],
  ["<all_urls>", "http://127.0.0.1/", true],
  ["<all_urls>", "file:///foo/bar", true],
  ["file:///foo*", "file:///foo", true],
  ["file:///foo*", "file:///foobar", true],
  ["http://www.example.com:80/foo", "http://www.example.com:80/foo", true],
  ["http://www.example.com:80/foo", "http://www.example.com/foo", true],
  ["http://www.example.com:80/foo", "http://www.example.com:8080/foo", false],
  ["http://www.example.com:*/foo", "http://www.example.com:8080/foo", true],
  ["*://example.com/*", "http://example.com./", true],
  ["*://example.com/*", "http://example.com../", true],
  ["*://example.com./*", "http://example.com/", true],
  ["*://*.gOoGle.com/*", "https://google.com/", true],
  ["*://*.gOoGle.com/*", "https://maps.google.com/", true],
  ["*://*.gOoGle.com/*", "https://example.com/", false],
  ["http://example.com/café/*", "http://example.com/caf%C3%A9", true],
  ["http://example.com/café/*", "http://example.com/caf%C3%A9/file.html", true],
  ["http://example.com/café/*", "http://example.com/CAF%C3%89", false],
  ["http://example.com/caf%C3%A9/*", "http://example.com/caf%C3%A9", true],
  ["http://example.com/foo%E1*", "http://example.com/foo%E1bar", true],
  ["http://example.com/foo%E1*", "http://example.com/foo%E1", true],
  ["http://example.com/foo%E1*", "http://example.com/foo%E2bar", false],
  ["http://*/%40*", "http://x.com/%40abc", true],
  ["http://*/%40*", "http://x.com/@abc", false],
  ["http://[2607:f8b0:4005:805::200e]/*", "http://[2607:f8b0:4005:805:0:0:0:200e]/x", true],
  ["http://[2607:f8b0:4005:805:0:0:0:200e]/*", "http://[2607:f8b0:4005:805::200e]/", true],
  ["http://[2607:f8b0:4005:805::200e]:8888/*", "http://[2607:f8b0:4005:805::200e]:8888/", true],
  ["http://[2607:f8b0:4005:805::200e]:8888/*", "http://[2607:f8b0:4005:805::200e]/", false],
  ["http://*.example.com/*", "http://127.0.0.1/", false],
  ["https://example.com/foo/*", "https://example.com/foo", true],
  ["https://example.com/foo/*", "https://example.com/foobar", false],
  ["http://127.1/*", "http://127.0.0.1/", true],
  ["http://2130706433/*", "http://127.0.0.1/", true],
  ["http://127.0.0.1/*", "http://127.1/", true],
  ["http://0x7f.1/*", "http://127.0.0.1/", true],
  ["https://bücher.example/*", "https://xn--bcher-kva.example/", true],
  ["https://xn--bcher-kva.example/*", "https://b\u00fccher.example/x", true],
  ["https://BÜCHER.example/*", "https://xn--bcher-kva.example/", true],
  ["https://example.com/%E2%80%8B*", "https://example.com/%E2%80%8Bx", true],
  ["https://example.com/\u200b*", "https://example.com/%E2%80%8Bx", false],
  ["https://example.com/\u00a0*", "https://example.com/%C2%A0x", false],
  ["https://example.com/%C2%A0*", "https://example.com/%C2%A0x", true],
  ["https://example.com/\u00e9*", "https://example.com/%C3%A9x", true],
  ["https://example.com/\u2800*", "https://example.com/%E2%A0%80", false],
  ["https://example.com/\u3164*", "https://example.com/%E3%85%A4", false],
  ["https://example.com/\u{1f511}*", "https://example.com/%F0%9F%94%91", true],
  ["https://example.com/\u{1f513}*", "https://example.com/%F0%9F%94%93", false],
];

const GLOB_URL_CASES: Array<[string, string, boolean]> = [
  ["https://example.com/*a?b", "https://example.com/aacb", false],
  ["https://example.com/*a?b", "https://example.com/xacb", true],
  ["https://example.com/*a?b", "https://example.com/xab", true],
  ["https://example.org/a?c", "https://example.org/ac", true],
  ["https://example.org/a?c", "https://example.org/abc", true],
  ["https://example.org/a?c", "https://example.org/abbc", false],
  ["https://example.org/\\*", "https://example.org/*", true],
  ["https://example.org/\\*", "https://example.org/x", false],
  ["*logout*", "https://example.org/logout", true],
];

const INVALID_PATTERNS = [
  "http://1z.1/*",
  "http://09.1/*",
  "http://0xfg.1/*",
  "http://*foo/bar",
  "http://foo.*.bar/baz",
  "http://bar",
  "http://",
  "http:///",
  "http://:1234/",
  "http://*./",
  "http://foo:/",
  "http://foo:com/",
  "http://foo:123456/",
  "http://foo:80:80/monkey",
  "http://foo.*/bar",
  "http://[2607:f8b0:4005:805::200e]:/*",
  "http://[]:8888/*",
  "http://[2607:f8b0:4005:805::200e/*",
  "http://[2607:f8b0:4005:805::200e]]/*",
  "http://[[2607:f8b0:4005:805::200e]/*",
  "http://[2607:f8b0:4005:805:200e]/*",
  "http://[2607:f8b0:4005:805:200e:12:bogus]/*",
  "https://[2607:f8b0:4005:805:200e]/*",
  "*://example.com:8080/*",
  "wss://example.com/*",
  "chrome://settings/*",
  "https://exa mple.com/*",
  "https://999.1.1.1/*",
  "https://example.com:070/*",
  "http://[fe80::1%25en0]/*",
  "http://[fe80::1%en0]/*",
  "http://exa%6Dple.com/*",
  "http://1.2.3.4.5/*",
  "http://example.123/*",
  "http://256.1.1.1/*",
  "https://straße.de/*",
];

const VALID_PATTERNS = [
  "http://foo:1234/",
  "http://foo:1234/bar",
  "http://*.foo:1234/",
  "http://*:1234/",
  "http://*:*/",
  "http://foo:*/",
  "http://*/:1234",
  "http://*.foo/bar:1234",
  "http://[2607:f8b0:4005:805::200e]/",
  "http://[2607:f8b0:4005:805::200e]:8888/*",
  "file://localhost/foo*",
  "http://127.1/*",
  "https://bücher.example/*",
  "https://é.com/*",
  "<all_urls>",
];

function metaFor(options: { matches?: string[]; exclude_matches?: string[]; includes?: string[]; excludes?: string[] }): Meta {
  return {
    name: "t",
    namespace: "",
    version: "",
    description: "",
    matches: options.matches ?? [],
    exclude_matches: options.exclude_matches ?? [],
    includes: options.includes ?? [],
    excludes: options.excludes ?? [],
    run_at: "document-end",
    inject_into: "page",
    noframes: false,
    warnings: [],
    id: "t",
    world: "MAIN",
  };
}

describe("URL Matching", () => {
  it("matches Chromium URL cases", () => {
    for (const [pattern, url, expected] of CHROMIUM_URL_CASES) {
      const meta = metaFor({ matches: [pattern] });
      expect(urlRuns(meta, url)).toBe(expected);
    }
  });

  it("matches glob cases", () => {
    for (const [glob, url, expected] of GLOB_URL_CASES) {
      const meta = metaFor({ includes: [glob] });
      expect(urlRuns(meta, url)).toBe(expected);
    }
  });

  it("rejects invalid patterns", () => {
    for (const pattern of INVALID_PATTERNS) {
      expect(() => {
        parseMeta(`// ==UserScript==\n// @match ${pattern}\n// ==/UserScript==\n`, "x.user.js");
      }).toThrow();
    }
  });

  it("accepts valid patterns", () => {
    for (const pattern of VALID_PATTERNS) {
      const meta = parseMeta(`// ==UserScript==\n// @match ${pattern}\n// ==/UserScript==\n`, "x.user.js");
      expect(meta.matches.length).toBe(1);
    }
  });

  it("matches pattern port and decode", () => {
    expect(urlmatch.matchPattern(urlmatch.decode(new TextEncoder().encode("www.google.com")), urlmatch.decode(new TextEncoder().encode("*.com")))).toBe(true);
  });
});

describe("Userscript Meta", () => {
  it("parses metadata correctly", () => {
    const src = `// ==UserScript==
// @name        Test Script
// @namespace   bay
// @version     1.2.3
// @description A sample script
// @match       https://example.com/*
// @exclude-match https://example.com/logout
// @run-at      document-start
// @inject-into page
// @noframes
// ==/UserScript==
console.log("hello");
`;
    const meta = parseMeta(src, "test.user.ts");
    expect(meta.name).toBe("Test Script");
    expect(meta.id).toBe("test-script");
    expect(meta.version).toBe("1.2.3");
    expect(meta.run_at).toBe("document-start");
    expect(meta.inject_into).toBe("page");
    expect(meta.world).toBe("MAIN");
    expect(meta.noframes).toBe(true);
    expect(meta.matches).toEqual(["https://example.com/*"]);
    expect(meta.exclude_matches).toEqual(["https://example.com/logout"]);
  });

  it("computes defaultUrl properly", () => {
    const meta = metaFor({ matches: ["https://example.com/path/*"] });
    expect(defaultUrl(meta)).toBe("https://example.com/path/");
  });
});

describe("Store", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `bay-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies installs and uninstalls cleanly", async () => {
    const store = new Store(root);
    store.open(true);
    store.lock();

    const scriptDir = join(tmpdir(), `bay-script-test-${Date.now()}`);
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "a.user.ts");
    writeFileSync(scriptPath, `// ==UserScript==\n// @name a\n// @match https://example.com/*\n// ==/UserScript==\nconsole.log(1);\n`, "utf8");
    const built = await build(scriptPath, { dataDirs: [root] });
    rmSync(scriptDir, { recursive: true, force: true });

    const [rec1, gen1] = store.apply({ add: built });
    expect(gen1).toBe(1);
    expect(rec1.id).toBe("a");
    expect(store.extensionPresent()).toBe(true);

    const [rec2, gen2] = store.apply({ remove: "a" });
    expect(gen2).toBe(2);
    expect(rec2.id).toBe("a");
    expect(store.installed().length).toBe(0);

    store.close();
  });
});

describe("CLI entrypoint", () => {
  it("prints version", async () => {
    let output = "";
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as never;
    try {
      const code = await main(["--version"]);
      expect(code).toBe(0);
      expect(output.trim()).toBe(`bay ${VERSION}`);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
