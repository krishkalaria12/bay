import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every web address Bay's own code names is in docs/privacy.md, with when and why Bay contacts it (or that it
// doesn't). A new endpoint fails this until the table says what it's for; a listed host the code no longer names
// fails it too.

const root = fileURLToPath(new URL("../../../", import.meta.url));

const SOURCES = [
  "apps/browser/src",
  "packages/chromium/src",
  "packages/chromium/ios",
  "packages/desktop/src",
  "packages/desktop/ios",
  "packages/sync/src",
  "packages/core/src",
  "packages/platform/src",
  "engine/chromium/src/chrome/browser/bay",
  "engine/nncore/src",
];

const CODE = /\.(ts|tsx|swift|mm|m|cc|h)$/;
const SKIPPED = /(\.test\.|_unittest\.|\/tests\/|\/fixtures\/|bangList\.ts$|siteSearch\.ts$|lucideSymbols\.web\.ts$)/;
const RESERVED = /(^|\.)(example|test|invalid|localhost|local)$|(^|\.)example\.(com|org|net|co\.uk)$|\.evil$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) yield* files(path);
    else if (CODE.test(name)) yield path;
  }
}

function namedHosts() {
  const hosts = new Map();

  for (const source of SOURCES) {
    for (const path of files(join(root, source))) {
      const file = relative(root, path);

      if (SKIPPED.test(file)) continue;

      for (const [, host] of readFileSync(path, "utf8").matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const name = host.toLowerCase();

        if (!RESERVED.test(name) && !name.includes(".evil.")) hosts.set(name, file);
      }
    }
  }

  return hosts;
}

function listedHosts() {
  const listed = new Set();

  for (const line of readFileSync(join(root, "docs/privacy.md"), "utf8").split("\n")) {
    const cell = line.match(/^\|\s*([^|]+?)\s*\|/)?.[1];

    if (!cell || cell === "Host" || cell.startsWith("---")) continue;

    for (const host of cell.split(",")) listed.add(host.trim().toLowerCase());
  }

  return listed;
}

test("every host Bay's code names is in docs/privacy.md", () => {
  const listed = listedHosts();
  const missing = [...namedHosts()].flatMap(([host, file]) => (listed.has(host) ? [] : [`${host} (${file})`]));
  assert.deepEqual(missing, [], "add these to docs/privacy.md, with when and why Bay contacts them");
});

test("docs/privacy.md lists no host the code no longer names", () => {
  const named = namedHosts();
  const stale = [...listedHosts()].filter((host) => !named.has(host));
  assert.deepEqual(stale, [], "remove these from docs/privacy.md");
});
