import assert from "node:assert/strict";
import { test } from "node:test";
import { docs, engineBoostCalls } from "@bay/shell";
import { engineBoosts, newBoost, DEFAULT_BOOST_COLOR } from "../lib/boosts.ts";
import { addBoost, setBoostScript, startBoosts, useBoosts } from "../components/boosts/state.ts";
import { useBrowser } from "../store/browser.ts";
import { webviewRef } from "../lib/webviews.ts";
import { boostsAdapter } from "./boosts.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("boost sync carries a boost's look and CSS, never its JavaScript", async () => {
  docs.delete("boosts.json");
  startBoosts();
  useBoosts.setState({ boosts: {}, scripts: {} });
  addBoost({ ...newBoost("b1", "example.com", 10), css: "body{}", zaps: [".ad"] }, "steal()");
  setBoostScript("b1", { enabled: true });
  const { values } = boostsAdapter.extract(() => undefined);
  assert.deepEqual([...values.keys()], ["boost:b1"]);
  const record = values.get("boost:b1");
  assert.equal(record.css, "body{}");
  assert.equal("id" in record, false);
  assert.equal(JSON.stringify([...values]).includes("steal"), false);
  // The script is saved on this Mac only.
  await wait(0);
  assert.match(docs.get("boosts.json"), /steal\(\)/);
});

test("boost sync applies records, ignores malformed ones and drops code from another Mac", () => {
  startBoosts();
  useBoosts.setState({ boosts: {}, scripts: {} });
  addBoost(newBoost("keep", "a.com", 1));
  addBoost(newBoost("gone", "b.com", 1), "local()");
  const visible = new Map([
    ["boost:new", { ...newBoost("ignored", "c.com", 2), script: "evil()", css: "p{}" }],
    ["boost:bad", { host: "not a host" }],
    ["boost:keep", 42],
  ]);
  boostsAdapter.apply(visible, new Set(["boost:new", "boost:bad", "boost:keep", "boost:gone"]), () => undefined);
  const s = useBoosts.getState();
  assert.deepEqual(Object.keys(s.boosts).sort(), ["keep", "new"]);
  assert.equal(s.boosts.new.host, "c.com");
  assert.equal(s.boosts.new.css, "p{}");
  assert.equal("script" in s.boosts.new, false);
  assert.equal(s.scripts.gone, undefined);
  assert.equal(s.scripts.new, undefined);
});

test("the engine hears about boosts that are on", async () => {
  startBoosts();
  useBoosts.setState({ boosts: {}, scripts: {}, on: true });
  addBoost({ ...newBoost("e1", "engine.test", 1), invert: true });
  await wait(120);
  const last = engineBoostCalls.at(-1);
  assert.deepEqual(
    last.map((b) => [b.host, b.invert]),
    [["engine.test", true]],
  );
  useBoosts.setState({ on: false });
  await wait(120);
  assert.deepEqual(engineBoostCalls.at(-1), []);
});

test("a synced host change cannot retarget a locally enabled script", () => {
  startBoosts();
  useBoosts.setState({ boosts: {}, scripts: {}, on: true });
  addBoost(newBoost("local", "original.example", 1), "document.body.dataset.local = 'yes'");
  setBoostScript("local", { enabled: true, privateWindows: true });
  const apply = (host) => boostsAdapter.apply(new Map([["boost:local", newBoost("local", host, 1)]]), new Set(["boost:local"]), () => undefined);
  apply("original.example");
  assert.equal(useBoosts.getState().scripts.local.enabled, true, "ordinary synced edits preserve local consent");
  apply("other.example");
  assert.equal(useBoosts.getState().boosts.local.host, "other.example");
  assert.equal(useBoosts.getState().scripts.local.enabled, false);
  assert.equal(useBoosts.getState().scripts.local.privateWindows, false);
  const retargeted = useBoosts.getState();
  assert.equal(engineBoosts(Object.values(retargeted.boosts), retargeted.scripts, retargeted.on)[0].script, "");
  assert.match(useBoosts.getState().scripts.local.code, /dataset.local/);
  apply("original.example");
  assert.equal(useBoosts.getState().scripts.local.enabled, false, "returning to the old host does not restore consent");
});

test("new views receive every destination's colours immediately, even on an unboosted site", async () => {
  startBoosts();
  useBoosts.setState({ boosts: {}, scripts: {}, on: true });
  addBoost({ ...newBoost("theme", "destination.example", 1), color: { ...DEFAULT_BOOST_COLOR, theme: true } });
  useBrowser.setState({ tabs: { palette: { id: "palette", spaceId: "default", url: "https://unboosted.example" } } });
  const calls = [];
  const ref = webviewRef("palette");
  ref({ setBoostStyle: (style) => (calls.push(style), Promise.resolve()) });
  assert.equal(calls.length, 1, "style is sent at attachment without waiting for the tab timer");
  assert.match(calls[0].palette, /--bay-palette-background/);
  assert.match(calls[0].sites["destination.example"], /html \{ filter:/);
  const before = calls[0];
  useBrowser.setState({ tabs: { palette: { id: "palette", spaceId: "default", url: "https://destination.example" } } });
  await wait(100);
  assert.equal(calls.length, 1, "navigation uses the existing per-host map without another style update");
  assert.deepEqual(calls[0], before);
  ref(null);
  useBrowser.setState({ tabs: {} });
});
