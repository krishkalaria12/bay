import assert from "node:assert/strict";
import { test } from "node:test";
import { customBangTable, findBang } from "./bangs.ts";
import { validateEngine } from "./engines.ts";
import { findScope, scopedSearchUrl } from "./siteSearch.ts";

test("custom IPv6 search destinations work for both shortcuts and bangs", () => {
  const input = { id: "local", name: "Local", keyword: "local", url: "http://[::1]:3000/search?q=%s", custom: true };
  assert.equal(validateEngine(input, []), null);
  const scope = findScope("local", { engines: [input] })!;
  assert.equal(scopedSearchUrl(scope, "react hooks", input), "http://[::1]:3000/search?q=react%20hooks");
  assert.equal(findBang("!local react hooks", customBangTable([input]))?.url, "http://[::1]:3000/search?q=react+hooks");
});

test("settings reject shortcuts and templates that cannot be used in bang mode", () => {
  const input = { name: "Docs", keyword: "docs", url: "https://docs.example/?q=%s" };
  for (const keyword of ["docs!", "!docs", "a!b"]) assert.match(validateEngine({ ...input, keyword }, [])!, /without !/);
  for (const url of ["https://%s.example/", "https://example.com:%s/", "https://%s@example.com/", "https://example.com%s/"]) {
    assert.match(validateEngine({ ...input, url }, [])!, /fixed website address/);
  }
  assert.equal(validateEngine(input, []), null);
});
