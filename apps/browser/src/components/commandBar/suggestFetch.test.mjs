import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_ENGINES, allEngines, createSuggestFetcher } from "@bay/core";
import { createSuggestionFetch, suggestionProfile } from "./suggestFetch.ts";

const tick = () => new Promise(setImmediate);

test("Google suggestions use the bounded native route rather than a page CORS request", async () => {
  const urls = [];
  const fetch = createSuggestionFetch(
    async () => assert.fail("web suggestions must not retry through browser CORS"),
    async (url) => {
      urls.push(url);
      return { body: '["bay",["bay browser","bay area"]]' };
    },
  );
  const fetcher = createSuggestFetcher({ fetch, delay: 0 });
  const suggestions = await new Promise((done) => fetcher.request(BUILT_IN_ENGINES[0], "bay", done));
  assert.deepEqual(suggestions, ["bay browser", "bay area"]);
  assert.equal(new URL(urls[0]).host, "suggestqueries.google.com");
  assert.equal(new URL(urls[0]).searchParams.get("q"), "bay");
  fetcher.cancel();
});

test("cancelled native requests reject immediately and late replies cannot revive them", async () => {
  let finish;
  const fetch = createSuggestionFetch(
    async () => assert.fail("unexpected browser fetch"),
    () => new Promise((done) => (finish = done)),
  );
  const controller = new AbortController();
  const pending = fetch("https://suggestqueries.google.com/complete/search?q=bay", { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await tick();
  controller.abort();
  await rejected;
  finish({ body: '["bay",["stale"]]' });
  await tick();
});

test("native errors stay failures and do not fall back to browser fetch", async () => {
  const fetch = createSuggestionFetch(
    async () => assert.fail("CORS failure is not a fallback path"),
    async () => {
      throw new Error("unapproved endpoint");
    },
  );
  await assert.rejects(fetch("https://unapproved.example/", { signal: new AbortController().signal }), /unapproved endpoint/);
});

test("native macOS fetch keeps its existing abort signal and response semantics", async () => {
  const controller = new AbortController();
  const response = { ok: false, text: async () => "" };
  const calls = [];
  const browserFetch = async (...args) => (calls.push(args), response);
  const fetch = createSuggestionFetch(browserFetch);
  assert.equal(await fetch("https://provider.example/", { signal: controller.signal }), response);
  assert.deepEqual(calls, [["https://provider.example/", { signal: controller.signal }]]);
});

test("an already cancelled request never enters the native bridge", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = createSuggestionFetch(
    async () => assert.fail("unexpected browser fetch"),
    async () => assert.fail("cancelled request must not start"),
  );
  await assert.rejects(fetch("https://provider.example/", { signal: controller.signal }), /cancelled/);
});

test("a malformed native body rejects rather than leaving the fetch pending", async () => {
  const fetch = createSuggestionFetch(
    async () => assert.fail("unexpected browser fetch"),
    async () => null,
  );
  await assert.rejects(fetch("https://provider.example/", { signal: new AbortController().signal }), /Invalid native suggestion response/);
});

test("extension suggestions retain their native owner profile across space changes and duplicate IDs", () => {
  const records = [
    {
      profile: "extension-owner",
      extensionId: "ext",
      extensionName: "Search",
      name: "Search",
      keyword: "search",
      url: "https://search.example/?q=%s",
      suggestUrl: "https://search.example/suggest?q=%s",
      isDefault: true,
    },
    {
      profile: "other-profile",
      extensionId: "ext",
      extensionName: "Search",
      name: "Search",
      keyword: "search",
      url: "https://other.example/?q=%s",
      suggestUrl: "https://other.example/suggest?q=%s",
      isDefault: false,
    },
  ];
  const selected = allEngines([], records).find((engine) => engine.extension);
  assert.equal(suggestionProfile(selected, records), "extension-owner");
  assert.equal(suggestionProfile(BUILT_IN_ENGINES[0], records), "");
  assert.equal(suggestionProfile(selected, []), null);
  assert.equal(suggestionProfile({ ...selected, suggestUrl: "https://unregistered.example/suggest?q=%s" }, records), null);
});
