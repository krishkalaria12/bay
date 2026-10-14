import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { DEFAULT_AWAKE_SITES } = await import("../lib/awakeSites.ts");
const { sidebarMetrics } = await import("../lib/sidebarDensity.ts");
const { sidebarEntries } = await import("../components/sidebar/entries.ts");
const { entryHeight, entriesHeight, rowSpan } = await import("../components/sidebar/geometry.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../lib/persist.ts");
const { settingsAdapter, profilesAdapter } = await import("../sync/adapters.ts");
const stub = await import("../test-native-stub.mjs");
const S = () => useBrowser.getState();

function tabs() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://today.example" });
  const today = Object.keys(S().tabs)[0];
  const pinned = S().newTab(w, { url: "https://pin.example", background: true });
  const folder = S().newPinnedFolder(w, { tabIds: [pinned], name: "Work" });
  return { w, today, pinned, folder };
}

test("old sessions seed awake sites, explicit empty lists survive and entries normalize", () => {
  S().hydrate({ settings: { appearance: "dark" } });
  assert.deepEqual(S().settings.awakeSites, DEFAULT_AWAKE_SITES);
  assert.equal(S().settings.density, "comfortable");
  S().hydrate({ settings: { awakeSites: [], density: "compact" } });
  assert.deepEqual(S().settings.awakeSites, []);
  assert.equal(S().settings.density, "compact");
  S().updateSettings({ awakeSites: ["https://MAIL.Google.com/inbox", "mail.google.com", "ftp://bad.example", "spotify.com"] });
  assert.deepEqual(S().settings.awakeSites, ["mail.google.com", "spotify.com"]);
  S().hydrate({ settings: { awakeSites: ["HTTPS://SLACK.COM/channel", "slack.com", " "], density: "invalid" } });
  assert.deepEqual(S().settings.awakeSites, ["slack.com"]);
  assert.equal(S().settings.density, "comfortable");
});

test("folded spaces and density survive session persistence without removing pinned or today tabs", () => {
  stub.docs.clear();
  const stop = startPersistence();
  const { w, today, pinned, folder } = tabs();
  const before = sidebarEntries(S(), w);
  S().updateSpace("default", { folded: true });
  S().updateSettings({ density: "compact", awakeSites: [] });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  assert.equal(S().spaces.default.folded, true);
  assert.equal(S().settings.density, "compact");
  assert.deepEqual(S().settings.awakeSites, []);
  assert.ok(S().tabs[pinned]);
  assert.ok(S().tabs[today]);
  assert.ok(S().pinnedFolders[folder]);
  const after = sidebarEntries(S(), w);
  assert.deepEqual(after.pinned, before.pinned);
  assert.deepEqual(after.pinnedGroups, before.pinnedGroups);
  assert.ok(after.list.includes(`t:${today}`));
  assert.equal(rowSpan(S(), w, "default", pinned, false), null, "hidden pinned tabs have no visible row to reveal");
  assert.equal(rowSpan(S(), w, "default", today, false)?.section, "list", "today's tabs remain visible");
  S().updateSpace("default", { folded: false });
  assert.equal(rowSpan(S(), w, "default", pinned, false)?.section, "pinned");
});

test("density resizes sidebar controls and folder/reveal geometry together", () => {
  const { w, today, folder } = tabs();
  const comfortable = sidebarMetrics(S().settings.density);
  assert.equal(comfortable.rowHeight, 36);
  assert.equal(comfortable.iconSize, 16);
  assert.equal(entryHeight(S(), w, "default", `f:${folder}`), 74);
  assert.equal(entriesHeight(S(), w, "default", [`t:${today}`, `f:${folder}`]), 112);
  assert.deepEqual(rowSpan(S(), w, "default", today, true), { section: "list", top: 42, height: 36 });
  S().updateSettings({ density: "compact" });
  const compact = sidebarMetrics(S().settings.density);
  for (const metric of ["rowHeight", "iconSize", "pinnedHeight", "addressHeight", "toolbarAddressHeight"]) assert.ok(compact[metric] < comfortable[metric]);
  assert.equal(entryHeight(S(), w, "default", `f:${folder}`), 62);
  assert.equal(entriesHeight(S(), w, "default", [`t:${today}`, `f:${folder}`]), 94);
  assert.deepEqual(rowSpan(S(), w, "default", today, true), { section: "list", top: 36, height: 30 });
});

test("density, awake sites and folded spaces round-trip sync; older profile records preserve folding", () => {
  S().hydrate({});
  S().updateSpace("default", { folded: true });
  S().updateSettings({ density: "compact", awakeSites: [] });
  const profile = profilesAdapter(() => ({ default: { syncId: "shared" } }));
  const settings = settingsAdapter.extract().values;
  const profiles = profile.extract().values;
  S().hydrate({});
  settingsAdapter.apply(settings, new Set(settings.keys()));
  profile.apply(profiles, new Set(profiles.keys()));
  assert.equal(S().settings.density, "compact");
  assert.deepEqual(S().settings.awakeSites, []);
  assert.equal(S().spaces.default.folded, true);
  const old = new Map([["prof:shared", { n: "Older", c: "purple", i: "🏠" }]]);
  profile.apply(old, new Set(old.keys()));
  assert.equal(S().spaces.default.name, "Older");
  assert.equal(S().spaces.default.folded, true);
  S().updateSpace("default", { folded: false });
  const expanded = profile.extract().values;
  S().updateSpace("default", { folded: true });
  profile.apply(expanded, new Set(expanded.keys()));
  assert.equal(S().spaces.default.folded, false);
  const invalid = new Map([
    ["set:density", { v: "bad" }],
    ["set:awakeSites", { v: null }],
  ]);
  settingsAdapter.apply(invalid, new Set(invalid.keys()));
  assert.equal(S().settings.density, "compact");
  assert.deepEqual(S().settings.awakeSites, []);
});
