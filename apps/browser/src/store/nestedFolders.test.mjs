import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { folderTabIds, folderDepth, folderRootId, canMoveFolder, childFolderIds } = await import("./folders.ts");
const { listIds } = await import("./model.ts");
const S = () => useBrowser.getState();
function setup() {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom" });
  const w = S().createWindow({ url: "https://first.example" });
  const a = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const b = S().newTab(w, { url: "https://second.example" });
  const c = S().newTab(w, { url: "https://third.example" });
  return { w, a, b, c, space: S().windows[w].spaceId };
}

test("nested folders cap the entire subtree at five levels and reject cycles and cross-space moves", () => {
  const { w } = setup();
  const chain = [S().newPinnedFolder(w, { name: "Root" })];
  for (let i = 1; i < 5; i++) chain.push(S().newPinnedFolder(w, { name: `Level ${i + 1}`, parentId: chain.at(-1) }));
  assert.equal(folderDepth(S(), chain.at(-1)), 5);
  assert.equal(folderRootId(S(), chain.at(-1)), chain[0]);
  assert.equal(S().newPinnedFolder(w, { parentId: chain.at(-1) }), "");
  assert.equal(canMoveFolder(S(), chain[0], chain[2]), false);
  const other = S().newPinnedFolder(w);
  assert.equal(canMoveFolder(S(), chain[0], other), false, "moving a subtree counts all descendants");
  const otherSpace = S().createSpace({ name: "Other" });
  const foreign = S().newPinnedFolder(w, { spaceId: otherSpace });
  assert.equal(canMoveFolder(S(), other, foreign), false);
  S().movePinnedFolder(chain[0], null, chain[2]);
  assert.equal(S().pinnedFolders[chain[0]].parentId, undefined);
});

test("subtree moves preserve direct memberships, move empty folders, and undo parent and ordering", () => {
  const { w, a, b, c, space } = setup();
  const root = S().newPinnedFolder(w, { name: "Root", tabIds: [a] });
  const child = S().newPinnedFolder(w, { name: "Child", parentId: root, tabIds: [b] });
  const target = S().newPinnedFolder(w, { name: "Target", tabIds: [c] });
  assert.deepEqual(new Set(folderTabIds(S(), root)), new Set([a, b]));
  assert.deepEqual(folderTabIds(S(), root, false), [a]);
  const prior = [...listIds(S(), space)];
  S().movePinnedFolder(root, null, target);
  assert.equal(S().pinnedFolders[root].parentId, target);
  assert.equal(S().pinnedFolders[child].parentId, root);
  assert.equal(S().tabs[b].folderId, child);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.equal(S().pinnedFolders[root].parentId, undefined);
  assert.deepEqual(listIds(S(), space), prior);
  S().movePinnedFolder(child, null, target);
  S().movePinnedFolder(child, a);
  assert.equal(S().pinnedFolders[child].parentId, target, "omitting parent keeps the existing parent");
  S().movePinnedFolder(child, null, null);
  assert.equal(S().pinnedFolders[child].parentId, undefined);
  const empty = S().newPinnedFolder(w, { parentId: root });
  S().movePinnedFolder(empty, null, target);
  assert.deepEqual(childFolderIds(S(), target), [empty]);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.equal(S().pinnedFolders[empty].parentId, root);
});

test("folder placement undo preserves navigation, new tabs and later folder renames", () => {
  const { w, a, b } = setup();
  const folder = S().newPinnedFolder(w, { tabIds: [a] });
  S().placeTabs([b], { pinned: false, row: true, folderId: folder });
  S().updateTab(b, { url: "https://changed.example", title: "Changed" });
  S().updatePinnedFolder(folder, { name: "Renamed" });
  const added = S().newTab(w, { url: "https://added.example" });
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.equal(S().tabs[b].pinnedRow, undefined);
  assert.equal(S().tabs[b].folderId, undefined);
  assert.equal(S().tabs[b].url, "https://changed.example");
  assert.ok(S().tabs[added]);
  assert.equal(S().pinnedFolders[folder].name, "Renamed");
  S().placeTabs([a], { pinned: false, row: true, folderId: null });
  assert.equal(S().tabs[a].folderId, undefined);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.equal(S().tabs[a].folderId, folder);
});

test("deleting a folder promotes direct rows and child folders without deleting the subtree", () => {
  const { w, a, b } = setup();
  const root = S().newPinnedFolder(w);
  const middle = S().newPinnedFolder(w, { parentId: root, tabIds: [a] });
  const child = S().newPinnedFolder(w, { parentId: middle, tabIds: [b] });
  S().deletePinnedFolder(middle);
  assert.equal(S().tabs[a].folderId, root);
  assert.equal(S().pinnedFolders[child].parentId, root);
  assert.equal(S().tabs[b].folderId, child);
  S().deletePinnedFolder(root);
  assert.equal(S().tabs[a].folderId, undefined);
  assert.equal(S().tabs[a].pinnedRow, true);
  assert.equal(S().pinnedFolders[child].parentId, undefined);
});

test("hydrate preserves flat and nested sessions and repairs malformed parents without losing rows", () => {
  const { w, a, b } = setup();
  const root = S().newPinnedFolder(w, { tabIds: [a] });
  const child = S().newPinnedFolder(w, { parentId: root, tabIds: [b] });
  const s = S();
  const data = { spaces: s.spaces, windows: s.windows, tabLists: s.tabLists, tabs: s.tabs, pinnedFolders: s.pinnedFolders };
  S().hydrate(data);
  assert.equal(S().pinnedFolders[child].parentId, root);
  assert.deepEqual(new Set(folderTabIds(S(), root)), new Set([a, b]));
  assert.deepEqual(S().folderMoveUndo, []);
  const flat = Object.fromEntries(Object.values(data.pinnedFolders).map(({ parentId: _parentId, ...folder }) => [folder.id, folder]));
  S().hydrate({ ...data, pinnedFolders: flat });
  assert.equal(S().pinnedFolders[child].parentId, undefined);
  S().hydrate({ ...data, pinnedFolders: { ...data.pinnedFolders, [root]: { ...data.pinnedFolders[root], parentId: child } } });
  for (const id of [root, child]) assert.ok(folderDepth(S(), id) <= 5);
  assert.ok(S().tabs[a] && S().tabs[b]);
  S().hydrate({ ...data, pinnedFolders: { ...data.pinnedFolders, [child]: { ...data.pinnedFolders[child], parentId: "missing" } } });
  assert.equal(S().pinnedFolders[child].parentId, undefined);
});

test("placing and undo retain source group membership, including deleted auto-ungroup groups", () => {
  const { w, a, b, c } = setup();
  const folder = S().newPinnedFolder(w);
  const group = S().groupTabs([a, b], { pinned: false });
  S().placeTabs([a], { pinned: false, row: true, folderId: folder });
  S().updateGroup(group, { name: "Renamed" });
  S().addTabsToGroup(group, [c]);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.deepEqual(new Set(S().groups[group].tabIds), new Set([a, b, c]));
  assert.equal(S().groups[group].name, "Renamed");
  S().updateGroup(group, { name: "Original" });
  useBrowser.setState({ groups: { [group]: { ...S().groups[group], tabIds: [a, b], autoUngroup: true } } });
  S().placeTabs([a], { pinned: false, row: true, folderId: folder });
  assert.equal(S().groups[group], undefined);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.deepEqual(new Set(S().groups[group].tabIds), new Set([a, b]));
});

test("child folders can stay between their parent's direct rows through movement and hydration", () => {
  const { w, a, b, c, space } = setup();
  S().placeTabs([a, b, c], { pinned: false, row: true });
  const root = S().newPinnedFolder(w, { tabIds: [a, b, c] });
  const child = S().newPinnedFolder(w, { parentId: root, tabIds: [b] });
  assert.deepEqual(listIds(S(), space), [a, b, c]);
  assert.deepEqual(folderTabIds(S(), root, false), [a, c]);
  S().movePinnedFolder(child, c);
  assert.deepEqual(listIds(S(), space), [a, b, c]);
  const s = S();
  S().hydrate({ spaces: s.spaces, windows: s.windows, tabLists: s.tabLists, tabs: s.tabs, pinnedFolders: s.pinnedFolders });
  assert.deepEqual(listIds(S(), space), [a, b, c]);
});

test("dropping a row into a parent appends after the entire subtree", () => {
  const { w, a, b, c, space } = setup();
  const root = S().newPinnedFolder(w, { tabIds: [a] });
  S().newPinnedFolder(w, { parentId: root, tabIds: [b] });
  S().placeTabs([c], { pinned: false, row: true, folderId: root });
  assert.deepEqual(listIds(S(), space), [a, b, c]);
  assert.equal(S().tabs[c].folderId, root);
});

test("filling anchored empty folders retains their header position, including empty sibling chains", () => {
  const { w, a, b, c, space } = setup();
  const root = S().newPinnedFolder(w, { tabIds: [a] });
  const empty = S().newPinnedFolder(w, { parentId: root, beforeId: a });
  const leading = S().newPinnedFolder(w, { parentId: root, beforeId: empty });
  S().placeTabs([b], { pinned: false, row: true, folderId: leading, beforeId: null });
  assert.deepEqual(listIds(S(), space), [b, a, c]);
  assert.equal(S().undoPinnedFolderMove(), true);
  const incoming = S().newPinnedFolder(w, { tabIds: [c] });
  S().movePinnedFolder(incoming, null, empty);
  assert.deepEqual(folderTabIds(S(), root), [c, a]);
  assert.equal(S().undoPinnedFolderMove(), true);
  assert.deepEqual(folderTabIds(S(), root), [a]);
});
