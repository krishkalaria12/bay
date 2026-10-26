import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as bundled from "../../../../../packages/core/src/bangList.ts";
import { bangDocument, findBang, MAX_BANG_LIST_CHARS } from "../../../../../packages/core/src/bangs.ts";
import { docs, heldSaves } from "../../test-native-stub.mjs";
import { bangStatus, createBangSubmitter, loadBangs, mayBeBang, refreshBangs, refreshBangsOnce, resetBangsForTests, topResultUrl } from "./bangs.ts";

const originalFetch = globalThis.fetch;
const originalRequire = globalThis.require;
let requests;
let loadCount;
const requireBundled = (id) => {
  assert.equal(id, "@bay/core/src/bangList.ts");
  loadCount++;
  return bundled;
};
const response = (status, body = null, headers = {}) => ({
  status,
  headers: new Headers({ "content-type": "application/json", ...headers }),
  text: async () => body,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const slim = [bundled.BANG_LIST, bundled.BANG_LIST_UNICODE].filter(Boolean).join("\n");
const updated = JSON.stringify([
  ...["gh", "w", "yt"].map((t) => ({ s: t, ts: [t], u: `https://${t}.example/?q={searchTerms}` })),
  ...Array.from({ length: 1100 }, (_, i) => ({ s: `Site ${i}`, ts: [`site${i}`], u: `https://site${i}.example/?q={searchTerms}` })),
]);

beforeEach(() => {
  docs.clear();
  heldSaves.on = false;
  heldSaves.queue.length = 0;
  resetBangsForTests();
  requests = [];
  loadCount = 0;
  globalThis.require = requireBundled;
  globalThis.fetch = async (...args) => {
    requests.push(args);
    return response(304);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.require = originalRequire;
});

test("the bundled catalog loads locally once without a split-bundle or network request", async () => {
  assert.equal(loadCount, 0);
  assert.equal(bangStatus().loaded, false);
  const [first, second] = await Promise.all([loadBangs(), loadBangs()]);
  assert.equal(first, second);
  assert.equal(findBang("!gh react", first)?.url, "https://github.com/search?q=react");
  assert.equal(findBang("!ют cats", first)?.bang.name, "YouTube");
  assert.equal(loadCount, 1);
  assert.deepEqual(requests, []);
});

test("a failed local load can be retried", async () => {
  globalThis.require = () => {
    throw new Error("temporary load failure");
  };
  await assert.rejects(loadBangs(), /temporary load failure/);
  globalThis.require = requireBundled;
  assert.ok((await loadBangs()).get("gh"));
});

test("valid saved catalogs load without the bundle, corrupt files fall back locally", async () => {
  docs.set("bangs.txt", bangDocument('"saved"', slim));
  assert.ok((await loadBangs()).get("gh"));
  assert.equal(bangStatus().source, "stored");
  assert.equal(loadCount, 0);
  resetBangsForTests();
  docs.set("bangs.txt", "truncated");
  assert.ok((await loadBangs()).get("gh"));
  assert.equal(bangStatus().source, "bundled");
});

test("only possible leading and trailing bangs wait on Enter, forced searches do not", () => {
  for (const text of ["!gh react", "react !w", " !YT ", "!unknown query"]) assert.equal(mayBeBang(text), true, text);
  for (const text of ["!", "hello!", "say !gh in the middle", "!gh!", "? !gh react", "?!w", "plain text"]) assert.equal(mayBeBang(text), false, text);
});

test("cold Enter waits for the catalog and commits once", async () => {
  const pending = deferred();
  const opened = [];
  const enter = createBangSubmitter(() => pending.promise);
  enter.submit("!gh react", (url) => opened.push(url));
  assert.deepEqual(opened, []);
  pending.resolve(await loadBangs());
  await tick();
  assert.deepEqual(opened, ["https://github.com/search?q=react"]);
});

test("editing, dismissing or replacing an Enter cancels its pending navigation", async () => {
  const pending = deferred();
  const opened = [];
  const enter = createBangSubmitter(() => pending.promise);
  enter.submit("!gh old", (url) => opened.push(url));
  enter.cancel();
  pending.resolve(await loadBangs());
  await tick();
  assert.deepEqual(opened, []);
  enter.submit("!gh old", (url) => opened.push(url));
  enter.submit("!w newer", (url) => opened.push(url));
  await tick();
  assert.deepEqual(opened, ["https://wikipedia.org/w/index.php?search=newer"]);
});

test("load errors and timeouts fall back once, with no late navigation", async () => {
  const opened = [];
  const failed = createBangSubmitter(() => Promise.reject(new Error("offline")));
  failed.submit("!gh react", (url) => opened.push(url));
  await tick();
  const pending = deferred();
  const late = createBangSubmitter(() => pending.promise, 5);
  await new Promise((resolve) =>
    late.submit("!w react", (url) => {
      opened.push(url);
      resolve();
    }),
  );
  pending.resolve(await loadBangs());
  await tick();
  assert.deepEqual(opened, [null, null]);
});

test("refresh sends the catalog ETag without cookies, deduplicates and throttles checks", async () => {
  const [first, second] = await Promise.all([refreshBangsOnce(), refreshBangsOnce()]);
  assert.equal(first, second);
  assert.equal(first.result, "unchanged");
  assert.equal(requests.length, 1);
  const [url, init] = requests[0];
  assert.equal(url, "https://services.helium.imput.net/bangs.json");
  assert.equal(init.headers["If-None-Match"], bundled.BANG_LIST_ETAG);
  assert.equal(init.credentials, "omit");
  assert.equal((await refreshBangs()).status, "skipped");
  assert.equal(requests.length, 1);
});

test("a refreshed table is published only after its list and ETag have saved together", async () => {
  globalThis.fetch = async () => response(200, updated, { etag: '"new"' });
  heldSaves.on = true;
  const pending = refreshBangs();
  while (!heldSaves.queue.length) await tick();
  assert.equal(bangStatus().source, "bundled");
  assert.equal(docs.has("bangs.txt"), false);
  heldSaves.queue.shift()();
  assert.equal((await pending).result, "updated");
  assert.equal(bangStatus().etag, '"new"');
  assert.equal(findBang("!gh react", await loadBangs())?.url, "https://gh.example/?q=react");
  resetBangsForTests();
  await loadBangs();
  assert.equal(bangStatus().source, "stored");
  assert.equal(bangStatus().etag, '"new"');
});

test("invalid, oversized and failed refreshes preserve the working catalog", async () => {
  for (const reply of [
    response(200, "[]"),
    response(200, updated, { "content-type": "text/html" }),
    response(200, updated, { "content-length": String(MAX_BANG_LIST_CHARS + 1) }),
    response(500),
  ]) {
    docs.clear();
    resetBangsForTests();
    globalThis.fetch = async () => reply;
    assert.equal((await refreshBangs()).result, "failed");
    assert.equal(findBang("!gh react", await loadBangs())?.url, "https://github.com/search?q=react");
    assert.equal(docs.has("bangs.txt"), false);
  }
});

test("shift-return on a search goes to its first result through DuckDuckGo's backslash redirect", () => {
  assert.equal(
    topResultUrl({ kind: "search", query: "bay browser github", url: "https://www.google.com/search?q=bay+browser+github" }),
    "https://duckduckgo.com/?q=%5Cbay%20browser%20github",
  );
  assert.equal(topResultUrl({ kind: "search", query: " c++ & rust ", suggested: true }), "https://duckduckgo.com/?q=%5Cc%2B%2B%20%26%20rust");
  // A search shortcut, an address or an empty query isn't a search to jump through.
  assert.equal(topResultUrl({ kind: "search", query: "cats", bang: true }), null);
  assert.equal(topResultUrl({ kind: "page", url: "https://example.com" }), null);
  assert.equal(topResultUrl({ kind: "search", query: "  " }), null);
  assert.equal(topResultUrl(undefined), null);
});
