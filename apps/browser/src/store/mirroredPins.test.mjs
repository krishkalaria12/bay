// As Arc's, pinned tabs and favourites are the space's, not a window's: every window shows the same ones, each with its
// own tab for them (a page opened in one window doesn't load in another).
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { sidebarEntries } = await import("../components/sidebar/entries.ts");
const parked = await import("./parkedPins.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com$/g, "");
const label = (id) => S().tabs[id].customTitle ?? short(id);
const entries = (w, profileId) => {
  const e = sidebarEntries(S(), w, profileId);
  const name = (entry) => {
    if (!entry.startsWith("f:")) return label(entry.slice(2));
    const f = S().pinnedFolders[entry.slice(2)];
    const rows = S().windows[w].tabIds.filter((id) => S().tabs[id].folderId === f.id).map(label);
    return `[${f.name}${rows.length ? `: ${rows.join(", ")}` : ""}]`;
  };
  return { tiles: e.tiles.map(label), pinned: e.pinned.map(name), list: e.list.map(name) };
};
const loaded = (id) => !!(S().tabs[id].navigation || S().tabs[id].adoptId);
const tabFor = (w, url) => S().windows[w].tabIds.find((id) => S().tabs[id].url === `https://${url}.com`);

// A window with a favourite (a), a pinned row (b) and a page (c); a second window on the same space with a page (d).
const setup = () => {
  S().hydrate({});
  const one = S().createWindow({ url: "https://a.com" });
  const a = S().windows[one].tabIds[0];
  const b = S().newTab(one, { url: "https://b.com" });
  S().newTab(one, { url: "https://c.com" });
  S().pinTabs([a], true);
  S().pinRows([b], true);
  const two = S().createWindow({ url: "https://d.com" });
  return { one, two, a, b };
};

test("a second window shows the space's favourites and pinned tabs, unloaded", () => {
  const { one, two } = setup();
  assert.deepEqual(entries(two), { tiles: ["a"], pinned: ["b"], list: ["d"] });
  assert.deepEqual(entries(one), { tiles: ["a"], pinned: ["b"], list: ["c"] }, "the first keeps its own pages");
  assert.ok(!loaded(tabFor(two, "a")) && !loaded(tabFor(two, "b")));
});

test("each window opens a pin in its own tab", () => {
  const { two, a } = setup();
  S().activate(tabFor(two, "a"));
  assert.ok(loaded(tabFor(two, "a")));
  assert.notEqual(tabFor(two, "a"), a);
  assert.equal(S().tabs[a].windowId !== two, true);
});

test("pinning, renaming and unpinning in one window does the same in the other", () => {
  const { one, two } = setup();
  S().pinTabs([tabFor(two, "d")], true);
  assert.deepEqual(entries(one).tiles, ["a", "d"]);
  S().updateTab(tabFor(one, "d"), { customTitle: "Docs" });
  assert.deepEqual(entries(two).tiles, ["a", "Docs"]);
  S().pinTabs([tabFor(one, "d")], false);
  assert.deepEqual(entries(two), { tiles: ["a"], pinned: ["b"], list: ["Docs"] }, "its open page stays in the window it's open in");
  assert.deepEqual(entries(one), { tiles: ["a"], pinned: ["b"], list: ["Docs", "c"] }, "the window that unpinned it keeps it, as a page");
});

test("unpinning a pin another window hasn't opened takes it away there", () => {
  const { one, two, b } = setup();
  S().pinRows([b], false);
  assert.deepEqual(entries(two), { tiles: ["a"], pinned: [], list: ["d"] });
  assert.deepEqual(entries(one).list, ["b", "c"]);
});

test("moving, re-homing and folders follow; collapsing a folder stays the window's", () => {
  const { one, two, a } = setup();
  const e = S().newTab(one, { url: "https://e.com" });
  S().pinTabs([e], true);
  S().moveTab(e, 0);
  assert.deepEqual(entries(two).tiles, ["e", "a"]);
  S().setPinnedUrl(a, "https://a2.com");
  assert.equal(S().tabs[tabFor(two, "a2")].pinnedUrl, "https://a2.com", "the unloaded tab shows its new page");
  const folder = S().newPinnedFolder(one, { name: "Work", tabIds: [tabFor(one, "b")] });
  assert.deepEqual(entries(two).pinned, ["[Work: b]"]);
  S().updatePinnedFolder(folder, { name: "Jobs", collapsed: true });
  const theirs = Object.values(S().pinnedFolders).find((f) => f.windowId === two);
  assert.equal(theirs.name, "Jobs");
  assert.equal(theirs.collapsed, false);
  S().newPinnedFolder(two, { name: "Empty" });
  assert.deepEqual(entries(one).pinned, ["[Jobs: b]", "[Empty]"]);
  S().deletePinnedFolder(folder);
  assert.deepEqual(entries(two).pinned, ["b", "[Empty]"]);
});

test("a window on a space with its own profile doesn't show them, until it switches to the space", () => {
  const { one } = setup();
  const personal = S().windows[one].profileId;
  const side = S().createProfile({ name: "Side" });
  const w = S().createWindow({ profileId: side, url: "https://s.com" });
  assert.deepEqual(entries(w), { tiles: [], pinned: [], list: ["s"] });
  S().switchProfile(w, personal);
  assert.deepEqual({ ...entries(w), list: [] }, { tiles: ["a"], pinned: ["b"], list: [] });
});

test("a space sharing the profile lists the favourites in every window, and its own pinned tabs only", () => {
  const { one, two } = setup();
  const work = S().createProfile({ name: "Work", shareWith: S().windows[one].profileId });
  S().switchProfile(two, work);
  assert.deepEqual(entries(two, work).tiles, ["a"]);
  assert.deepEqual(entries(two, work).pinned, []);
  S().pinRows([S().windows[two].activeTabIds[work]], true);
  S().switchProfile(one, work);
  assert.equal(entries(one, work).pinned.length, 1);
});

test("a pin dragged to another window takes the place of its tab there; it leaves one behind", () => {
  const { one, two, a } = setup();
  S().activate(a);
  const theirs = tabFor(two, "a");
  S().moveTabsToWindow([a], two);
  assert.equal(S().tabs[theirs], undefined, "the other window's unloaded tab for it went");
  assert.equal(S().tabs[a].windowId, two);
  assert.deepEqual(entries(two).tiles, ["a"]);
  assert.deepEqual(entries(one).tiles, ["a"], "the first window still has it");
  assert.ok(!loaded(tabFor(one, "a")));
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://a.com").length, 2);
});

test("merging windows keeps one tab for each pin", () => {
  const { one, two } = setup();
  S().mergeAllWindows(one);
  assert.deepEqual(entries(one), { tiles: ["a"], pinned: ["b"], list: ["c", "d"] });
  assert.equal(S().windows[two], undefined);
});

test("closing one of two windows parks nothing; closing the last parks its pins for the next", () => {
  const { one, two } = setup();
  S().closeWindow(one);
  assert.deepEqual(S().parkedPins, {});
  assert.deepEqual(entries(two).tiles, ["a"]);
  S().closeWindow(two);
  assert.deepEqual(S().parkedPins.default.tabs.map((t) => t.url), ["https://a.com", "https://b.com"]);
  const n = S().createWindow();
  assert.deepEqual({ ...entries(n), list: [] }, { tiles: ["a"], pinned: ["b"], list: [] });
});

test("a session from before keeps every window's pins: each window has them all, once", () => {
  S().hydrate({});
  const w = (id, tabIds) => ({ id, profileId: "default", incognito: false, tabIds, activeTabIds: { default: tabIds.at(-1) }, sidebarOpen: true, frame: null, createdAt: 0 });
  const t = (id, windowId, url, pin) => ({
    ...model.makeTab(windowId, "default", url),
    id,
    pinned: pin === "tile",
    ...(pin === "row" ? { pinnedRow: true } : {}),
    pinnedUrl: pin ? url : null,
  });
  S().hydrate({
    windows: { w1: w("w1", ["a1", "b1", "p1"]), w2: w("w2", ["a2", "c2", "p2"]) },
    windowOrder: ["w1", "w2"],
    tabs: {
      a1: t("a1", "w1", "https://a.com", "tile"),
      b1: t("b1", "w1", "https://b.com", "row"),
      p1: t("p1", "w1", "https://p.com"),
      a2: t("a2", "w2", "https://a.com", "tile"),
      c2: t("c2", "w2", "https://c.com", "tile"),
      p2: t("p2", "w2", "https://q.com"),
    },
    focusedWindowId: "w2",
  });
  assert.deepEqual(entries("w2"), { tiles: ["a", "c"], pinned: ["b"], list: ["q"] });
  assert.deepEqual(entries("w1"), { tiles: ["a", "c"], pinned: ["b"], list: ["p"] });
  assert.ok(S().tabs.a1 && S().tabs.a2, "a page both had keeps both its tabs");
});

test("parking every window's pins (a launch that doesn't restore them) parks each pin and folder once", () => {
  const { one, two } = setup();
  S().newPinnedFolder(one, { name: "Work", tabIds: [tabFor(one, "b")] });
  const { parkWindowPins } = parked;
  let park = {};
  for (const w of [one, two]) park = parkWindowPins(park, S().windows[w], S());
  assert.deepEqual(park.default.tabs.map((t) => t.url), ["https://a.com", "https://b.com"]);
  assert.equal(park.default.folders.length, 1);
});
