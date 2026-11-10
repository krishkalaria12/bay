import assert from "node:assert/strict";
import { test } from "node:test";
import * as v from "valibot";

await import("../test-native-stub.mjs");

const { sessionJson } = await import("./persist.ts");
const { useBrowser } = await import("../store/browserStore.ts");
const { normalizeLocalFiles } = await import("../store/localFiles.ts");

// session.json as it was written before tabs' JSON was cached: one JSON.stringify of the whole document.
function wholeDocument(s) {
  const incognito = (id) => id.startsWith("incognito:");
  const publicTab = (t) => !incognito(t.spaceId);
  const windows = Object.values(s.windows).filter((w) => !w.incognito && w.kind !== "small");
  const kept = new Set(windows.map((w) => w.id));
  const tabs = Object.values(s.tabs).filter((t) => !incognito(t.spaceId) && s.windows[t.windowId]?.kind !== "small" && !t.peekOf);
  const saved = new Set(tabs.map((t) => t.id));

  return JSON.stringify({
    version: 2,
    spaces: s.spaces,
    spaceOrder: s.spaceOrder,
    orphanedProfileData: s.orphanedProfileData,
    settings: s.settings,
    windows,
    windowOrder: s.windowOrder.filter((id) => kept.has(id)),
    focusedWindowId: s.ui.focusOrder.find((id) => kept.has(id)) ?? null,
    tabs: tabs.map(({ navigation: _n, adoptId: _a, wakeAdoptId: _w, ...t }) => (kept.has(t.windowId) ? t : { ...t, windowId: "" })),
    tabLists: Object.fromEntries(
      Object.entries(s.tabLists)
        .map(([key, ids]) => [key, ids.filter((id) => saved.has(id))])
        .filter(([, ids]) => ids.length),
    ),
    groups: Object.values(s.groups).filter((g) => !incognito(g.spaceId)),
    pinnedFolders: Object.values(s.pinnedFolders),
    localFiles: Object.values(normalizeLocalFiles(s.localFiles, s.spaces)),
    splits: Object.values(s.splits).filter((v) => v.tabIds.every((id) => saved.has(id))),
    closedTabs: s.closedTabs.filter((c) => publicTab(c.tab)),
    closedWindows: s.closedWindows.filter((c) => c.tabs.every(publicTab)),
    closedGroups: s.closedGroups.filter((c) => c.tabs.every(publicTab)),
    deletedGroups: s.deletedGroups.filter((c) => c.tabs.every(publicTab)),
    cleanedTabs: s.cleanedTabs.filter((c) => publicTab(c.tab)),
  });
}

const tab = (id, patch = {}) => ({ id, windowId: "w1", spaceId: "default", url: `https://${id}.example/`, title: `Tab "${id}"\n`, lastActiveAt: 1, ...patch });

function fixture() {
  return {
    spaces: { default: { id: "default", name: "Personal", color: "blue", icon: null, createdAt: 0 } },
    spaceOrder: ["default"],
    orphanedProfileData: [],
    settings: { restoreSession: true, unreadBadges: true },
    windows: {
      w1: { id: "w1", spaceId: "default", activeTabIds: { default: "a" }, sidebarOpen: true, frame: null },
      small: { id: "small", spaceId: "default", kind: "small", activeTabIds: {} },
      private: { id: "private", spaceId: "incognito:1", incognito: true, activeTabIds: {} },
    },
    windowOrder: ["w1", "small", "private"],
    ui: { focusOrder: ["private", "w1"] },
    tabs: {
      a: tab("a", { navigation: { url: "https://a.example/" }, adoptId: "adopt", wakeAdoptId: "wake", emoji: "🌊" }),
      b: tab("b", { customTitle: undefined, pinnedRow: true }),
      detached: tab("detached", { windowId: "gone" }),
      little: tab("little", { windowId: "small" }),
      peek: tab("peek", { peekOf: "a" }),
      secret: tab("secret", { windowId: "private", spaceId: "incognito:1" }),
    },
    tabLists: { default: ["a", "b", "detached", "peek"], small: ["little"], "incognito:1": ["secret"] },
    groups: { g: { id: "g", spaceId: "default", tabIds: ["a"] }, pg: { id: "pg", spaceId: "incognito:1", tabIds: ["secret"] } },
    pinnedFolders: {},
    localFiles: {},
    splits: { s: { id: "s", tabIds: ["a", "b"] }, ps: { id: "ps", tabIds: ["a", "secret"] } },
    closedTabs: [{ tab: tab("closed") }, { tab: tab("closedSecret", { spaceId: "incognito:1" }) }],
    closedWindows: [],
    closedGroups: [],
    deletedGroups: [],
    cleanedTabs: [],
  };
}

test("session.json is byte-identical to stringifying the whole document, across tab edits", () => {
  let s = fixture();
  assert.equal(sessionJson(s), wholeDocument(s));
  // A switch stamps one tab; a title changes; a tab moves out of its window; a tab closes.
  s = { ...s, tabs: { ...s.tabs, a: { ...s.tabs.a, lastActiveAt: 2 } } };
  assert.equal(sessionJson(s), wholeDocument(s));
  s = { ...s, tabs: { ...s.tabs, b: { ...s.tabs.b, title: "Renamed" } } };
  assert.equal(sessionJson(s), wholeDocument(s));
  s = { ...s, windows: { ...s.windows, w2: { ...s.windows.w1, id: "w2" } }, tabs: { ...s.tabs, detached: { ...s.tabs.detached, windowId: "w2" } } };
  assert.equal(sessionJson(s), wholeDocument(s));
  const { b: _, ...rest } = s.tabs;
  s = { ...s, tabs: rest };
  assert.equal(sessionJson(s), wholeDocument(s));
  // The same tab record in a window that's gone is written without its window.
  const { w2: _w2, ...windows } = s.windows;
  s = { ...s, windows };
  assert.equal(sessionJson(s), wholeDocument(s));
  assert.ok(!sessionJson(s).includes("secret"));
});

// Count actual tab JSON.stringify calls, independently of how persistence caches them.
function tabSerializations(run) {
  const stringify = JSON.stringify;
  const ids = [];
  JSON.stringify = (value, ...args) => {
    if (value && v.is(v.object({}), value) && v.is(v.string(), value.id) && v.is(v.string(), value.url)) ids.push(value.id);

    return stringify(value, ...args);
  };

  try {
    run();
  } finally {
    JSON.stringify = stringify;
  }

  return ids;
}

test("later saves reuse the JSON of shared tabs retained by closeWindow", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const closing = S().createWindow({ url: "https://closed.example/" });
  const first = S().windows[closing].activeTabIds.default;
  const second = S().newTab(closing, { url: "https://background.example/", background: true });
  const keep = S().createWindow({ url: "https://keep.example/" });
  assert.equal(sessionJson(S()), wholeDocument(S()));
  S().closeWindow(closing);
  assert.equal(S().windows[closing], undefined);

  for (const id of [first, second]) {
    assert.equal(S().tabs[id].windowId, "");
    assert.equal(S().tabs[id].unloaded, true);
    assert.ok(S().tabLists.default.includes(id));
  }

  assert.equal(sessionJson(S()), wholeDocument(S()));
  const sourceTab = S().tabs[first];
  S().toggleSidebar(keep);
  const expected = wholeDocument(S());
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(S()), expected)),
    [],
  );
  assert.equal(S().tabs[first], sourceTab);

  // A replacement record with the same id must write its new fields once.
  S().updateTab(first, { title: 'Changed "title"\n🌊' });
  assert.notEqual(S().tabs[first], sourceTab);
  const edited = wholeDocument(S());
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(S()), edited)),
    [first],
  );
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(S()), edited)),
    [],
  );
});

test("the same record keeps distinct owned and detached bytes when its owner changes", () => {
  const s = fixture();

  // Preserve unusual key order and escaped keys/values through both serialization variants.
  const sourceTab = {
    0: "numeric key",
    id: 'escaped"id',
    title: 'quote" and slash\\',
    navigation: null,
    'odd"key': "line\n🌊",
    spaceId: "default",
    url: "https://escaped.example/",
    windowId: "w1",
  };

  s.tabs = { escaped: sourceTab };
  s.tabLists = { 'default"\\\n': [sourceTab.id] };
  const owner = s.windows.w1;
  const owned = wholeDocument(s);
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), owned)),
    [sourceTab.id],
  );
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), owned)),
    [],
  );
  delete s.windows.w1;
  const detached = wholeDocument(s);
  assert.notEqual(detached, owned);
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), detached)),
    [sourceTab.id],
  );
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), detached)),
    [],
  );
  s.windows.w1 = owner;
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), owned)),
    [],
  );
  delete s.windows.w1;
  assert.deepEqual(
    tabSerializations(() => assert.equal(sessionJson(s), detached)),
    [],
  );
  assert.equal(s.tabs.escaped, sourceTab);
  assert.equal(sourceTab.windowId, "w1");
});
