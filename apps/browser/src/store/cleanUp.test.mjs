// The automatic clean up is Arc's archive: on by default after 12 hours, for every space of every window (not only
// the one on screen), each space after its own time if it has one.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browserStore.ts");
const { cleanUpHours } = await import("./tabTidying.ts");
const model = await import("./model.ts");

const S = () => useBrowser.getState();
// These cases read lists in the order their tabs opened: new tabs go to the bottom.
(await import("./settings.ts")).DEFAULT_SETTINGS.newTabPosition = "bottom";
const HOUR = 3_600_000;
const urls = (w, spaceId) => model.viewTabIds(S(), w, spaceId).map((id) => S().tabs[id].url);

// Personal with an active page (a.com) and one unused for `hours` (b.com); Work with the same, c.com and d.com. The
// window ends on Personal.
const setup = (hours) => {
  S().hydrate({});
  const personal = S().settings.defaultSpaceId;
  const work = S().createSpace({ name: "Work" });
  const w = S().createWindow({ spaceId: personal, url: "https://a.com" });
  const b = S().newTab(w, { url: "https://b.com", background: true });
  S().switchSpace(w, work);
  S().navigate(S().windows[w].activeTabIds[work], "https://c.com");
  const d = S().newTab(w, { url: "https://d.com", background: true });
  S().switchSpace(w, personal);
  for (const id of [b, d]) S().updateTab(id, { lastActiveAt: Date.now() - hours * HOUR });
  return { personal, work, w };
};

test("a new install cleans up tabs unused for 12 hours", () => {
  S().hydrate({});
  assert.equal(S().settings.cleanUpInactiveTabsAfterHours, 12);
  assert.equal(cleanUpHours(S(), S().settings.defaultSpaceId), 12);
});

test("a saved choice to never clean up stays", () => {
  S().hydrate({ settings: { cleanUpInactiveTabsAfterHours: null } });
  assert.equal(S().settings.cleanUpInactiveTabsAfterHours, null);
});

test("the automatic clean up reaches the spaces a window isn't showing", () => {
  const { personal, work, w } = setup(13);
  assert.equal(S().cleanUpInactiveTabs(), 2);
  assert.deepEqual(urls(w, personal), ["https://a.com"]);
  assert.deepEqual(urls(w, work), ["https://c.com"], "Work's active tab stays");
  assert.equal(S().windows[w].spaceId, personal, "the window stays on its space");
});

test("a space's own time overrides the app's, and never keeps its tabs", () => {
  const { personal, work, w } = setup(30);
  S().updateSpace(personal, { cleanUpAfterHours: 168 });
  S().updateSpace(work, { cleanUpAfterHours: null });
  assert.equal(S().cleanUpInactiveTabs(), 0);
  S().updateSpace(personal, { cleanUpAfterHours: 24 });
  S().updateSettings({ cleanUpInactiveTabsAfterHours: null });
  assert.equal(S().cleanUpInactiveTabs(), 1, "Personal's 24 hours, with the app's turned off");
  assert.deepEqual(urls(w, work), ["https://c.com", "https://d.com"]);
});

test("Clean Up Tabs from the menu cleans the space on screen only", () => {
  const { work, w } = setup(13);
  assert.equal(S().cleanUpTabs(w), 1);
  assert.equal(urls(w, work).length, 2);
});

test("restoring one cleaned up tab puts it back in its space and returns it, as the command bar needs", () => {
  const { work, w } = setup(13);
  S().cleanUpInactiveTabs();
  const entry = S().cleanedTabs.find((c) => c.tab.url === "https://d.com");
  assert.ok(entry);
  const id = S().restoreCleaned(entry.id, w);
  assert.equal(S().tabs[id]?.url, "https://d.com");
  assert.equal(S().tabs[id].spaceId, work);
  assert.equal(S().windows[w].spaceId, work);
  assert.equal(S().windows[w].activeTabIds[work], id);
  assert.ok(!S().cleanedTabs.some((c) => c.id === entry.id));
  // Gone once restored, so a second pick falls back to opening the page.
  assert.equal(S().restoreCleaned(entry.id, w), undefined);
});

const { cleanUpCandidates, hasCleanUpCandidates } = await import("./tabTidying.ts");

// Keep the original enumeration as an independent oracle for the short-circuit query.
function originalCandidates(s, windowId, inactiveForMs, now, spaceId) {
  const view = model.viewTabIds(s, windowId, spaceId);
  const space = spaceId ?? s.windows[windowId]?.spaceId ?? "";
  const shown = new Set(Object.keys(s.windows).map((w) => model.activeTabId(s, w, space)));
  const active = model.activeTabId(s, windowId, spaceId);
  const grouped = new Set(Object.values(s.groups).flatMap((g) => g.tabIds));
  const split = new Set(Object.values(s.splits).flatMap((v) => v.tabIds));
  const keep = (t) => shown.has(t.id) || model.pinnedPage(t) || t.kept || s.live[t.id]?.playingAudio;
  const out = new Set();
  const byPage = new Map();
  for (const id of view) {
    const t = s.tabs[id];
    if (t.url) {
      const key = t.url.replace(/#.*$/, "");
      byPage.set(key, [...(byPage.get(key) ?? []), t]);
    }
  }
  for (const same of byPage.values()) {
    if (same.length < 2) continue;
    const keeper = same.find(model.pinnedPage) ?? same.find((t) => t.id === active) ?? [...same].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    for (const t of same) if (t !== keeper && !keep(t) && !split.has(t.id)) out.add(t.id);
  }
  for (const id of view) {
    const t = s.tabs[id];
    if (!keep(t) && !grouped.has(id) && !split.has(id) && now - t.lastActiveAt >= inactiveForMs) out.add(id);
  }
  return view.filter((id) => out.has(id));
}

function candidateFixture() {
  S().hydrate({});
  const space = S().settings.defaultSpaceId;
  const work = S().createSpace({ name: "Work" });
  const window = S().createWindow({ spaceId: space, url: "https://active.test" });
  const other = S().createWindow({ spaceId: space, url: "https://other.test" });
  const base = S();
  const active = base.windows[window].activeTabIds[space];
  const tab = base.tabs[active];
  const make = (id, patch = {}) => ({ ...tab, id, url: `https://${id}.test`, lastActiveAt: 90, ...patch });
  const state = (tabs, extra = {}) => ({
    ...base,
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    tabLists: { [model.spaceListKey(base, space)]: tabs.map((t) => t.id) },
    windows: {
      [window]: { ...base.windows[window], activeTabIds: { [space]: "active" } },
      [other]: { ...base.windows[other], activeTabIds: { [space]: "other" } },
    },
    groups: {},
    splits: {},
    live: {},
    ...extra,
  });
  return { space, work, window, other, make, state };
}

test("cleanup keeps duplicate precedence, group differences, other windows and splits", () => {
  const { window, other, make, state, space } = candidateFixture();
  const page = "https://same.test";
  const cases = [
    { tabs: [make("first", { url: page }), make("second", { url: page, pinnedRow: true })], want: ["first"] },
    { tabs: [make("pinned", { url: page, pinned: true }), make("active", { url: page }), make("newest", { url: page, lastActiveAt: 110 })], want: ["newest"] },
    { tabs: [make("first", { url: page, lastActiveAt: 99 }), make("active", { url: page })], want: ["first"] },
    { tabs: [make("first", { url: page }), make("second", { url: page })], want: ["second"] },
    { tabs: [make("first", { url: page }), make("newer", { url: page, lastActiveAt: 99 })], want: ["first"] },
    {
      tabs: [make("kept", { url: page, kept: true }), make("audio", { url: page }), make("other", { url: page })],
      extra: { live: { audio: { playingAudio: true } } },
      want: [],
    },
    {
      tabs: [make("first", { url: page }), make("grouped", { url: page })],
      extra: { groups: { g: { tabIds: ["grouped"], pinned: true } } },
      want: ["grouped"],
    },
    { tabs: [make("grouped")], extra: { groups: { g: { tabIds: ["grouped"] } } }, threshold: 0, want: [] },
    {
      tabs: [make("first", { url: page }), make("split", { url: page }), make("other", { url: page })],
      extra: { splits: { s: { tabIds: ["split"] } } },
      want: [],
    },
    { tabs: [make("future", { lastActiveAt: 101 })], threshold: 0, want: [] },
    { tabs: [make("boundary", { lastActiveAt: 90 })], threshold: 10, want: ["boundary"] },
    { tabs: [make("blank", { url: "" })], threshold: 0, want: ["blank"] },
  ];
  for (const { tabs, extra, threshold = 100, want } of cases) {
    const s = state(tabs, extra);
    assert.deepEqual(cleanUpCandidates(s, window, threshold, 100), want);
    assert.equal(hasCleanUpCandidates(s, window, threshold, 100), want.length > 0);
    assert.deepEqual(cleanUpCandidates(s, window, threshold, 100), originalCandidates(s, window, threshold, 100));
  }
  const s = state([make("active"), make("other")]);
  s.windows[other] = { ...s.windows[other], spaceId: "another", activeTabIds: { [space]: "other" } };
  assert.equal(hasCleanUpCandidates(s, window, 0, 100), false, "remembered tabs in windows showing another space stay");
});

test("cleanup boolean and enumeration exactly match the original over deterministic randomized states", () => {
  const { window, other, make, state, space, work } = candidateFixture();
  let seed = 0x65ab713;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const timestamps = [-Infinity, -10, 0, 90, 100, 101, Infinity, NaN];
  for (let fixture = 0; fixture < 300; fixture++) {
    const tabs = Array.from({ length: random(45) }, (_, i) =>
      make(`t${i}`, {
        url: ["", "https://a.test", "https://a.test#one", "https://a.test/", "https://b.test#two", "invalid#hash"][random(6)],
        spaceId: random(5) ? space : work,
        lastActiveAt: timestamps[random(timestamps.length)],
        pinned: random(9) === 0,
        pinnedRow: random(7) === 0,
        kept: random(8) === 0,
      }),
    );
    const s = state(tabs);
    for (const t of tabs) {
      if (random(7) === 0) s.live[t.id] = { playingAudio: true };
      if (random(4) === 0) (s.groups.g ??= { tabIds: [], pinned: random(2) === 0 }).tabIds.push(t.id);
      if (random(5) === 0) (s.splits.s ??= { tabIds: [] }).tabIds.push(t.id);
    }
    s.windows[window].activeTabIds = { [space]: `t${random(45)}`, [work]: `t${random(45)}` };
    s.windows[other].activeTabIds = { [space]: `t${random(45)}`, [work]: `t${random(45)}` };
    s.windows[other].spaceId = random(2) ? space : work;
    if (random(4) === 0) {
      s.windows[window].kind = "small";
      s.tabLists[window] = tabs.map((t) => t.id);
    }
    for (const id of [window, "missing"])
      for (const requestedSpace of [undefined, space, work])
        for (const threshold of [0, 10, 100, -1, NaN]) {
          const expected = originalCandidates(s, id, threshold, 100, requestedSpace);
          assert.deepEqual(cleanUpCandidates(s, id, threshold, 100, requestedSpace), expected, `fixture ${fixture}`);
          assert.equal(hasCleanUpCandidates(s, id, threshold, 100, requestedSpace), expected.length > 0, `fixture ${fixture}`);
        }
  }
});

test("the boolean exits before inspecting later candidates or building duplicate buckets", () => {
  const { window, make, state } = candidateFixture();
  const first = make("first");
  const later = make("later");
  Object.defineProperty(first, "url", {
    get() {
      throw new Error("duplicate buckets built");
    },
  });
  Object.defineProperty(later, "lastActiveAt", {
    get() {
      throw new Error("scan did not stop");
    },
  });
  assert.equal(hasCleanUpCandidates(state([first, later]), window, 0, 100), true);
});
