// The Pinned section (Arc's and Zen's pinned tabs): full rows below the Essentials, loose or in folders. They aren't
// groups: a group never holds one, and a folder stays when it's emptied.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { folderTabIds } = await import("./folders.ts");
const { sidebarEntries } = await import("../components/sidebar/entries.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com$/g, "");
const order = (w) => S().windows[w].tabIds.map(short);
const entries = (w) => {
  const e = sidebarEntries(S(), w);
  const name = (entry) => (entry.startsWith("f:") ? `[${S().pinnedFolders[entry.slice(2)].name}]` : short(entry.slice(2)));
  return { tiles: e.tiles.map(short), pinned: e.pinned.map(name), list: e.list.map(name) };
};

const setup = (...urls) => {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${urls[0]}.com` });
  const ids = [S().windows[w].tabIds[0], ...urls.slice(1).map((u) => S().newTab(w, { url: `https://${u}.com` }))];
  return [w, ...ids];
};

test("pinned rows sit between the Essentials and the list, and keep the page they were pinned at", () => {
  const [w, a, b, c] = setup("a", "b", "c", "d");
  S().pinTabs([a], true);
  S().pinRows([c, b], true);
  assert.deepEqual(entries(w), { tiles: ["a"], pinned: ["b", "c"], list: ["d"] });
  assert.deepEqual(order(w), ["a", "b", "c", "d"]);
  assert.equal(S().tabs[b].pinnedUrl, "https://b.com");
  assert.ok(model.inPinnedContainer(S(), b));
});

test("unpinning a row puts it at the top of the list", () => {
  const [w, , b] = setup("a", "b", "c");
  S().pinRows([b], true);
  S().pinRows([b], false);
  assert.deepEqual(entries(w), { tiles: [], pinned: [], list: ["b", "a", "c"] });
  assert.equal(S().tabs[b].pinnedRow, undefined);
  assert.equal(S().tabs[b].pinnedUrl, null);
});

test("closing a pinned row unloads it and keeps it pinned", () => {
  const [w, a, b] = setup("a", "b");
  S().pinRows([b], true);
  S().activate(b);
  S().closeTab(b);
  assert.ok(S().tabs[b], "the row stays");
  assert.ok(S().tabs[b].unloaded);
  assert.equal(model.activeTabId(S(), w), a);
});

test("a row can become an Essential and back without leaving the Pinned section's page", () => {
  const [w, a] = setup("a", "b");
  S().pinRows([a], true);
  S().pinTabs([a], true);
  assert.deepEqual(entries(w), { tiles: ["a"], pinned: [], list: ["b"] });
  S().placeTabs([a], { pinned: false, row: true });
  assert.deepEqual(entries(w), { tiles: [], pinned: ["a"], list: ["b"] });
  assert.equal(S().tabs[a].pinnedUrl, "https://a.com");
});

test("a folder gathers its rows together, and they can be dropped in and out of it", () => {
  const [w, a, b, c, d] = setup("a", "b", "c", "d", "e");
  S().pinRows([a, b, c], true);
  const f = S().newPinnedFolder(w, { tabIds: [a, c], name: "Work" });
  assert.deepEqual(entries(w).pinned, ["[Work]", "b"]);
  assert.deepEqual(folderTabIds(S(), f).map(short), ["a", "c"]);
  // From the list straight into the folder, before c.
  S().placeTabs([d], { pinned: false, row: true, folderId: f, beforeId: c });
  assert.deepEqual(folderTabIds(S(), f).map(short), ["a", "d", "c"]);
  assert.deepEqual(entries(w), { tiles: [], pinned: ["[Work]", "b"], list: ["e"] });
  // Out of the folder, loose, before it.
  S().placeTabs([c], { pinned: false, row: true, folderId: null, beforeId: a });
  assert.deepEqual(entries(w).pinned, ["c", "[Work]", "b"]);
  assert.deepEqual(order(w), ["c", "a", "d", "b", "e"]);
});

test("a folder stays when it's emptied, and deleting it keeps its rows pinned", () => {
  const [w, a, b] = setup("a", "b", "c");
  S().pinRows([a, b], true);
  const f = S().newPinnedFolder(w, { tabIds: [a], name: "Read" });
  S().pinRows([a], false);
  assert.deepEqual(entries(w).pinned, ["b", "[Read]"], "empty, it shows after the rows");
  S().placeTabs([b], { pinned: false, row: true, folderId: f });
  assert.deepEqual(entries(w).pinned, ["[Read]"]);
  S().deletePinnedFolder(f);
  assert.deepEqual(entries(w).pinned, ["b"]);
  assert.equal(S().tabs[b].folderId, undefined);
});

test("moving a folder moves all its rows", () => {
  const [w, a, b, c] = setup("a", "b", "c", "d");
  S().pinRows([a, b, c], true);
  const f = S().newPinnedFolder(w, { tabIds: [b, c], name: "F" });
  S().movePinnedFolder(f, a);
  assert.deepEqual(entries(w).pinned, ["[F]", "a"]);
  assert.deepEqual(order(w), ["b", "c", "a", "d"]);
  S().movePinnedFolder(f, null);
  assert.deepEqual(entries(w).pinned, ["a", "[F]"]);
});

test("groups never take a pinned row", () => {
  const [w, a, b] = setup("a", "b", "c");
  S().pinRows([a], true);
  const g = S().groupTabs([a, b], { pinned: false });
  assert.deepEqual(S().groups[g].tabIds.map(short), ["b"]);
  assert.ok(S().tabs[a].pinnedRow);
  // Dropped into a group, a row leaves the Pinned section.
  S().placeTabs([a], { pinned: false, groupId: g });
  assert.equal(S().tabs[a].pinnedRow, undefined);
  assert.deepEqual(sidebarEntries(S(), w).pinned, []);
});

test("cleaning up leaves pinned rows alone", () => {
  const [w, , b] = setup("a", "b", "c");
  S().pinRows([b], true);
  for (const t of Object.values(S().tabs)) S().updateTab(t.id, { lastActiveAt: 0 });
  S().cleanUpTabs(w, { inactiveForMs: 1 });
  assert.ok(S().tabs[b]);
});

test("a window's pinned rows and folders come back with the next window of its space", () => {
  const [w, a, b] = setup("a", "b", "c");
  S().pinRows([a, b], true);
  const f = S().newPinnedFolder(w, { tabIds: [b], name: "Kept" });
  S().newPinnedFolder(w, { name: "Empty" });
  const profileId = S().windows[w].profileId;
  S().closeWindow(w);
  assert.equal(S().pinnedFolders[f], undefined, "the window's folders go with it");
  const w2 = S().createWindow({ profileId, url: "https://z.com" });
  assert.deepEqual(entries(w2).pinned, ["a", "[Kept]", "[Empty]"]);
  const kept = Object.values(S().pinnedFolders).find((x) => x.name === "Kept");
  assert.deepEqual(folderTabIds(S(), kept.id).map(short), ["b"]);
});

test("a session keeps its folders, and drops the mark of a folder that's gone", () => {
  const [w, a, b] = setup("a", "b");
  S().pinRows([a, b], true);
  const f = S().newPinnedFolder(w, { tabIds: [a], name: "Saved" });
  const s = S();
  const data = { profiles: s.profiles, windows: s.windows, tabs: s.tabs, pinnedFolders: s.pinnedFolders };
  S().hydrate(data);
  assert.deepEqual(entries(w).pinned, ["[Saved]", "b"]);
  S().hydrate({ ...data, pinnedFolders: {} });
  assert.deepEqual(entries(w).pinned, ["a", "b"]);
  assert.equal(S().tabs[a].folderId, undefined, `no longer in ${f}`);
});
