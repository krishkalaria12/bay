import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@bay/shell" && context.parentURL?.endsWith("/developer/devMode.ts")) {
      return { url: "data:text/javascript,export const copyText = () => {}", shortCircuit: true };
    }
    if (specifier === "../layout/splitActions" && context.parentURL?.endsWith("/developer/devMode.ts")) {
      return { url: "data:text/javascript,export const showToast = () => {}", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { useBrowser } = await import("../../store/browser.ts");
const { webviews } = await import("../../lib/webviews.ts");
const dev = await import("./devMode.ts");
const { JSON_VIEWER_SCRIPT } = await import("./jsonViewerScript.ts");
const S = () => useBrowser.getState();
dev.startDeveloperMode();

function setup(url) {
  webviews.clear();
  dev.useDeveloperUi.setState({ offers: {}, inspecting: {} });
  S().hydrate({});
  const w = S().createWindow({ url });
  const id = S().windows[w].activeTabIds.default;
  const scripts = [];
  webviews.set(id, { evaluate: async (code) => scripts.push(code), focus: async () => {} });
  return { w, id, scripts };
}

test("local server offers survive progress and disappear after answering or navigation", () => {
  const { w, id } = setup("http://localhost:7101/one");
  assert.equal(dev.useDeveloperUi.getState().offers[id], "localhost:7101");
  const offers = dev.useDeveloperUi.getState().offers;
  for (let i = 0; i < 60; i++) S().updateLive(id, { progress: i / 100 });
  assert.strictEqual(dev.useDeveloperUi.getState().offers, offers);
  const other = S().newTab(w, { url: "http://localhost:7101/two" });
  assert.deepEqual(Object.keys(dev.useDeveloperUi.getState().offers), [id], "only one offer per site");
  dev.answerDeveloperOffer(id, false);
  S().activate(other);
  assert.deepEqual(dev.useDeveloperUi.getState().offers, {});
  S().updateTab(other, { url: "http://localhost:7102/" });
  assert.equal(dev.useDeveloperUi.getState().offers[other], "localhost:7102");
  S().updateTab(other, { url: "https://example.com" });
  assert.deepEqual(dev.useDeveloperUi.getState().offers, {});
});

test("JSON viewing follows load completion and newly enabled sites, without rerunning on progress", () => {
  const { id, scripts } = setup("http://localhost:7103/data.json");
  S().updateLive(id, { isLoading: true });
  dev.setDeveloperMode(S().tabs[id].url, true);
  assert.deepEqual(scripts, [], "wait for a loading document");
  S().updateLive(id, { isLoading: false });
  assert.deepEqual(scripts, [JSON_VIEWER_SCRIPT]);
  for (let i = 0; i < 60; i++) S().updateLive(id, { progress: i / 100 });
  assert.equal(scripts.length, 1);
  dev.setDeveloperMode(S().tabs[id].url, false);
  dev.setDeveloperMode(S().tabs[id].url, true);
  assert.deepEqual(scripts, [JSON_VIEWER_SCRIPT, JSON_VIEWER_SCRIPT], "turning on a loaded site takes effect immediately");
});

test("inspector returns after navigation and stops when its site is disabled or tab closes", () => {
  const { id, scripts } = setup("http://localhost:7104/");
  dev.setDeveloperMode(S().tabs[id].url, true);
  dev.setInspecting(id, true);
  const before = scripts.length;
  S().updateLive(id, { isLoading: true });
  S().updateLive(id, { progress: 0.5 });
  assert.equal(scripts.length, before);
  S().updateLive(id, { isLoading: false });
  assert.equal(scripts.length, before + 2, "JSON viewer and inspector are restored once after loading");
  dev.setDeveloperMode(S().tabs[id].url, false);
  assert.equal(dev.useDeveloperUi.getState().inspecting[id], undefined);
  dev.setDeveloperMode(S().tabs[id].url, true);
  dev.setInspecting(id, true);
  S().closeTab(id);
  assert.equal(dev.useDeveloperUi.getState().inspecting[id], undefined);
});

test("a progress update never reads unrelated loading records", async () => {
  const { id } = setup("https://example.com");
  let unrelatedReads = 0;
  const live = new Proxy(
    { ...S().live, [id]: { ...S().live[id], progress: 0.5 }, unrelated: { isLoading: false } },
    {
      get(target, key) {
        if (key === "unrelated") unrelatedReads++;
        return Reflect.get(target, key);
      },
    },
  );
  useBrowser.setState({ live });
  const { withChangedEntry } = await import("../../store/changes.ts");
  const next = withChangedEntry(live, id, { ...live[id], progress: 0.6 });
  unrelatedReads = 0;
  useBrowser.setState({ live: next });
  assert.equal(unrelatedReads, 0, "the known delta must skip all unrelated records");
});
