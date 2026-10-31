// The Pinned section (Arc's and Zen's pinned tabs): full rows below the Essentials, loose or in folders. They aren't
// groups: a group never holds one, and a folder stays when it's emptied.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { folderTabIds } = await import("./folders.ts");
const { folderEntries, numberedTabs, sidebarEntries } = await import("../components/sidebar/entries.ts");

const S = () => useBrowser.getState();
// These cases read lists in the order their tabs opened: new tabs go to the bottom.
(await import("./settings.ts")).DEFAULT_SETTINGS.newTabPosition = "bottom";
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com$/g, "");
const order = (w) => model.listIds(S(), model.windowListKey(S(), S().windows[w])).map(short);
const entries = (w) => {
  const e = sidebarEntries(S(), w);
  const name = (entry) => (entry.startsWith("f:") ? `[${S().pinnedFolders[entry.slice(2)].name}]` : short(entry.slice(2)));
  return { tiles: e.tiles.map(short), pinned: e.pinned.map(name), list: e.list.map(name) };
};

const setup = (...urls) => {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${urls[0]}.com` });
  const ids = [S().windows[w].activeTabIds[S().windows[w].spaceId], ...urls.slice(1).map((u) => S().newTab(w, { url: `https://${u}.com` }))];
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

test("a space's pinned rows and folders stay when its window closes, and show in its next window", () => {
  const [w, a, b] = setup("a", "b", "c");
  S().pinRows([a, b], true);
  const f = S().newPinnedFolder(w, { tabIds: [b], name: "Kept" });
  S().newPinnedFolder(w, { name: "Empty" });
  const spaceId = S().windows[w].spaceId;
  S().closeWindow(w);
  assert.ok(S().pinnedFolders[f], "the space's folders stay");
  const w2 = S().createWindow({ spaceId, url: "https://z.com" });
  assert.deepEqual(entries(w2).pinned, ["a", "[Kept]", "[Empty]"]);
  const kept = Object.values(S().pinnedFolders).find((x) => x.name === "Kept");
  assert.deepEqual(folderTabIds(S(), kept.id).map(short), ["b"]);
});

test("a session keeps its folders, and drops the mark of a folder that's gone", () => {
  const [w, a, b] = setup("a", "b");
  S().pinRows([a, b], true);
  const f = S().newPinnedFolder(w, { tabIds: [a], name: "Saved" });
  const s = S();
  const data = { spaces: s.spaces, windows: s.windows, tabs: s.tabs, pinnedFolders: s.pinnedFolders };
  S().hydrate(data);
  assert.deepEqual(entries(w).pinned, ["[Saved]", "b"]);
  S().hydrate({ ...data, pinnedFolders: {} });
  assert.deepEqual(entries(w).pinned, ["a", "b"]);
  assert.equal(S().tabs[a].folderId, undefined, `no longer in ${f}`);
});

// A split pinned as one row (Arc's): every pane a pinned row, kept whole while unloaded.
const { pinRowTitle, rowPinned } = await import("./splits.ts");
const pinnedSplit = (...urls) => {
  const [w, a, b, ...rest] = setup(...urls);
  const split = S().createSplit([a, b]);
  S().pinRows([a], true);
  return { w, a, b, rest, split };
};
const rows = (w) => sidebarEntries(S(), w);

test("pinning a split's pane pins the whole split as one row, and unpinning takes it back to the list", () => {
  const [w, a, b, c] = setup("a", "b", "c");
  const split = S().createSplit([a, b]);
  assert.equal(pinRowTitle(S(), a), "Pin Split View");
  S().pinRows([b], true);
  assert.deepEqual(rows(w).pinned, [`s:${split}`]);
  assert.deepEqual(rows(w).list, [`t:${c}`]);
  assert.equal(S().tabs[a].pinnedUrl, "https://a.com");
  assert.equal(S().tabs[b].pinnedUrl, "https://b.com");
  assert.equal(rowPinned(S(), a), true);
  assert.equal(pinRowTitle(S(), a), "Unpin Split View");
  S().pinRows([a], false);
  assert.deepEqual(rows(w).pinned, []);
  assert.deepEqual(rows(w).list.toSorted(), [`s:${split}`, `t:${c}`].toSorted());
  assert.equal(S().splits[split].tabIds.length, 2);
});

test("a split with an Essential pins pane by pane", () => {
  const [w, a, b] = setup("a", "b", "c");
  const split = S().createSplit([a, b]);
  S().pinTabs([a], true);
  assert.equal(pinRowTitle(S(), b), "Pin Tab");
  S().pinRows([b], true);
  assert.equal(S().tabs[a].pinned, true, "the Essential stays one");
  assert.ok(S().splits[split]);
  assert.deepEqual(rows(w).pinned, [`t:${b}`]);
});

test("closing a pane unloads the pinned split whole; it stays a split, and a click brings it back", () => {
  const { w, a, b, rest, split } = pinnedSplit("a", "b", "c");
  S().activate(a, w);
  S().closeTab(a);
  assert.ok(S().splits[split], "still a split");
  assert.deepEqual(S().splits[split].tabIds, [a, b]);
  assert.ok(S().tabs[a].unloaded && S().tabs[b].unloaded, "both panes unloaded");
  assert.equal(S().tabs[a].navigation, null);
  assert.equal(S().tabs[b].navigation, null);
  assert.equal(model.activeTabId(S(), w), rest[0], "the window moves on to a regular tab");
  assert.deepEqual(rows(w).pinned, [`s:${split}`]);
  S().activate(b, w);
  assert.equal(S().tabs[b].unloaded, undefined);
  assert.ok(S().tabs[b].navigation);
});

test("a blank pane of a pinned split closes for good, and a new pane is pinned with its split", () => {
  const { w, a, b, split } = pinnedSplit("a", "b", "c");
  S().activate(a, w);
  const pane = S().openSplitPane(w).tabId;
  assert.equal(S().tabs[pane].pinnedRow, true);
  assert.deepEqual(rows(w).pinned, [`s:${split}`]);
  S().closeTab(pane);
  assert.equal(S().tabs[pane], undefined);
  assert.deepEqual(S().splits[split].tabIds, [a, b]);
  assert.ok(S().tabs[a].unloaded, "closing unloads what's left of it, as any pane does");
});

test("a pinned split moves into a folder and out whole, and stays one row there", () => {
  const { w, a, b, split } = pinnedSplit("a", "b", "c");
  const folder = S().newPinnedFolder(w);
  S().placeTabs([a], { pinned: false, row: true, folderId: folder });
  assert.equal(S().tabs[a].folderId, folder);
  assert.equal(S().tabs[b].folderId, folder);
  assert.deepEqual(rows(w).pinned, [`f:${folder}`]);
  assert.deepEqual(folderEntries(S(), folder), [`s:${split}`]);
  S().placeTabs([b], { pinned: false, row: true, folderId: null });
  assert.deepEqual(rows(w).pinned.includes(`s:${split}`), true);
  assert.equal(S().tabs[a].folderId, undefined);
});

test("removing a pane leaves both pinned, as rows of their own", () => {
  const { w, a, b, split } = pinnedSplit("a", "b", "c");
  S().removeTabFromSplit(a);
  assert.equal(S().splits[split], undefined);
  assert.deepEqual(rows(w).pinned.toSorted(), [`t:${a}`, `t:${b}`].toSorted());
});

test("a pinned split is saved, comes back, and takes one number", () => {
  const { w, a, b, split } = pinnedSplit("a", "b", "c");
  S().activate(b, w);
  assert.ok(numberedTabs(S(), w).includes(b));
  assert.ok(!numberedTabs(S(), w).includes(a), "one number per split, as in the list");
  const saved = JSON.parse(JSON.stringify({ tabs: S().tabs, tabLists: S().tabLists, splits: S().splits, spaces: S().spaces, spaceOrder: S().spaceOrder }));
  S().hydrate(saved);
  assert.ok(S().splits[split]);
  assert.equal(S().tabs[a].pinnedRow, true);
  assert.equal(S().tabs[b].pinnedRow, true);
});

test("a pinned split stays whole when its window closes, for the next window", () => {
  const { w, a, b, split } = pinnedSplit("a", "b", "c");
  const spaceId = S().windows[w].spaceId;
  S().closeWindow(w);
  assert.deepEqual(S().splits[split].tabIds, [a, b]);
  const next = S().createWindow({ spaceId });
  assert.deepEqual(rows(next).pinned, [`s:${split}`]);
});
