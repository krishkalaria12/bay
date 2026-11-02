import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeColorFor, scopeColorsFor } from "./scopeColors.ts";

const empty = { tabs: {}, live: {} };
const scope = (url, kind = "site") => ({ kind, name: "Site", host: "", url });

test("site accents follow the destination host, including subdomains, without matching lookalikes", () => {
  assert.equal(scopeColorFor(scope("https://www.youtube.com/results?q=%s"), empty, "default"), "#D90000");
  assert.equal(scopeColorFor(scope("https://music.youtube.com/search?q=%s"), empty, "default"), "#D90000");
  assert.equal(scopeColorFor(scope("https://youtube.com.evil.example/?q=%s"), empty, "default"), null);
  assert.equal(scopeColorFor({ ...scope("https://docs.example/?q=%s"), name: "YouTube" }, empty, "default"), null);
  assert.equal(scopeColorFor(null, empty, "default"), null);
  assert.equal(scopeColorFor(scope("https://youtube.com/", "history"), empty, "default"), null);
});

test("custom sites reuse a valid page color only from their own profile", () => {
  const state = {
    tabs: { work: { url: "https://docs.example/page", spaceId: "work" }, other: { url: "https://other.example/", spaceId: "default" } },
    live: { work: { themeColor: "#123456" }, other: { themeColor: "#ABCDEF" } },
  };
  assert.equal(scopeColorFor(scope("https://docs.example/?q=%s"), state, "work"), "#123456");
  assert.equal(scopeColorFor(scope("https://docs.example/?q=%s"), state, "default"), null);
  state.live.work.themeColor = "invalid";
  assert.equal(scopeColorFor(scope("https://docs.example/?q=%s"), state, "work"), null);
});

test("the pill and selected row can share readable text for bright and dark site accents", () => {
  assert.deepEqual(scopeColorsFor("#D90000"), { background: "#D90000", text: "#FFFFFF" });
  assert.deepEqual(scopeColorsFor("#FF9900"), { background: "#FF9900", text: "#000000" });
  assert.deepEqual(scopeColorsFor("#000000"), { background: "#000000", text: "#FFFFFF" });
  assert.deepEqual(scopeColorsFor("#FFFFFF"), { background: "#FFFFFF", text: "#000000" });
  assert.equal(scopeColorsFor(null), null);
});
