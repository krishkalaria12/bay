import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { viewTabIds } = await import("./model.ts");
const S = () => useBrowser.getState();
function setup() {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom", cmdClickCreatesTabGroup: false });
  const w = S().createWindow({ url: "https://a.test" });
  const a = viewTabIds(S(), w)[0];
  const b = S().newTab(w, { url: "https://b.test", background: true });
  const c = S().newTab(w, { url: "https://c.test", background: true });
  return { w, a, b, c };
}

test("Clear is one undo transaction restoring all tabs in place without losing later pages", () => {
  const { w, a, b, c } = setup();
  const order = viewTabIds(S(), w);
  assert.equal(S().cleanUpTabs(w, { inactiveForMs: 0 }), 2);
  assert.equal(S().sidebarUndo[w].length, 1);
  const later = S().newTab(w, { url: "https://later.test", background: true });
  S().updateTab(a, { title: "Page updated", url: "https://a.test/next" });
  assert.equal(S().undoSidebarEdit(w), true);
  assert.deepEqual(viewTabIds(S(), w), [...order, later]);
  assert.equal(S().tabs[a].title, "Page updated");
  assert.equal(S().tabs[a].url, "https://a.test/next");
  assert.ok(S().tabs[b]);
  assert.ok(S().tabs[c]);
  assert.equal(S().cleanedTabs.length, 0);
});

test("pin, rename, icon, theme and moves undo in order while navigation keeps its latest value", () => {
  const { w, b } = setup();
  const space = S().windows[w].spaceId;
  const originalTheme = S().spaces[space].theme;
  S().pinRows([b], true);
  S().updateTab(b, { customTitle: "Docs" });
  S().updateTab(b, { customIcon: "📚" });
  S().updateSpace(space, { theme: { colors: ["#123456"], intensity: 0.5, grain: 0 } });
  S().updateTab(b, { title: "New title", url: "https://b.test/new" });
  assert.equal(S().sidebarUndo[w].length, 4);
  S().undoSidebarEdit(w);
  assert.deepEqual(S().spaces[space].theme, originalTheme);
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].customIcon, null);
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].customTitle, null);
  S().undoSidebarEdit(w);
  assert.ok(!S().tabs[b].pinnedRow);
  assert.equal(S().tabs[b].url, "https://b.test/new");
  assert.equal(S().tabs[b].title, "New title");
});

test("each window owns its undo history and closing a private window discards it", () => {
  const { w, b } = setup();
  S().updateTab(b, { customTitle: "First window" });
  const other = S().createWindow();
  S().updateTab(b, { customIcon: "📎" });
  assert.equal(S().sidebarUndo[w].length, 1);
  assert.equal(S().sidebarUndo[other].length, 1);
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].customTitle, null);
  assert.equal(S().tabs[b].customIcon, "📎");
  S().undoSidebarEdit(other);
  assert.equal(S().tabs[b].customIcon, null);
  const privateWindow = S().createWindow({ incognito: true });
  const tab = S().newTab(privateWindow, { url: "https://private.test" });
  S().updateTab(tab, { customTitle: "Private" });
  assert.ok(S().sidebarUndo[privateWindow].length);
  S().closeWindow(privateWindow);
  assert.equal(S().sidebarUndo[privateWindow], undefined);
  assert.equal(S().undoSidebarEdit(privateWindow), false);
});

test("close restores a split and its group, using lazy native history restoration", () => {
  const { w, b, c } = setup();
  const split = S().createSplit([b, c]);
  const group = S().groupTabs([b, c], { name: "Research", pinned: false });
  const order = viewTabIds(S(), w);
  S().closeTabs([b, c]);
  assert.equal(S().tabs[b], undefined);
  S().undoSidebarEdit(w);
  assert.deepEqual(viewTabIds(S(), w), order);
  assert.deepEqual(S().splits[split].tabIds, [b, c]);
  assert.deepEqual(S().groups[group].tabIds, [b, c]);
  assert.equal(S().tabs[b].wakeAdoptId, `restore:${b}`);
  assert.equal(S().tabs[b].navigation, null);
  assert.equal(S().closedTabs.length, 0);
});

test("folder movement undo preserves later renaming and newly created tabs", () => {
  const { w, b } = setup();
  const parent = S().newPinnedFolder(w, { name: "Parent" });
  const child = S().newPinnedFolder(w, { name: "Child", tabIds: [b] });
  S().movePinnedFolder(child, null, parent);
  S().updatePinnedFolder(child, { name: "Changed later" });
  const later = S().newTab(w, { url: "https://later.test" });
  S().undoSidebarEdit(w);
  S().undoSidebarEdit(w);
  assert.equal(S().pinnedFolders[child].parentId, undefined);
  assert.ok(S().tabs[later]);
});

test("undoing a close never discards a replacement tab the user has since navigated", () => {
  const { w, a, b, c } = setup();
  S().closeTabs([a, b, c]);
  const replacement = viewTabIds(S(), w)[0];
  S().navigate(replacement, "https://replacement.test");
  S().undoSidebarEdit(w);
  assert.ok(S().tabs[replacement]);
  assert.ok(viewTabIds(S(), w).includes(replacement));
  assert.equal(S().tabs[replacement].url, "https://replacement.test");
});

test("automatic cleanup and remote edits never enter sidebar undo history", async () => {
  const { w, a, b } = setup();
  const { withoutSidebarUndo } = await import("./sidebarUndo.ts");
  const space = S().windows[w].spaceId;
  S().updateSettings({ cleanUpInactiveTabsAfterHours: 1 });
  S().updateTab(b, { lastActiveAt: 0 });
  S().cleanUpInactiveTabs();
  withoutSidebarUndo(() => S().updateSpace(space, { name: "Synced name" }));
  S().navigated(a, { url: "https://a.test/new", title: "New page" }, {});
  assert.deepEqual(S().sidebarUndo, {});
});

test("file pin, rename, reorder and remove use the same per-window undo history", () => {
  const { w } = setup();
  const [file, folder] = S().pinLocalFiles(w, [
    { path: "/tmp/a.pdf", name: "A", kind: "file" },
    { path: "/tmp/docs", name: "Docs", kind: "folder" },
  ]);
  S().renameLocalFile(file, "Reference");
  S().moveLocalFile(folder, file);
  S().removeLocalFile(file);
  S().undoSidebarEdit(w);
  assert.equal(S().localFiles[file].name, "Reference");
  S().undoSidebarEdit(w);
  assert.ok(S().localFiles[file].order < S().localFiles[folder].order);
  S().undoSidebarEdit(w);
  assert.equal(S().localFiles[file].name, "A");
  S().undoSidebarEdit(w);
  assert.deepEqual(S().localFiles, {});
});

test("Clear undo reinserts missing rows even when another window reordered survivors", () => {
  const { w, a, b, c } = setup();
  S().updateTab(b, { kept: true });
  useBrowser.setState({ sidebarUndo: {} });
  S().cleanUpTabs(w, { inactiveForMs: 0 });
  const other = S().createWindow();
  S().moveTab(b, 0);
  assert.equal(S().tabs[c], undefined);
  S().undoSidebarEdit(w);
  assert.ok(viewTabIds(S(), w).includes(c));
  const survivors = viewTabIds(S(), w).filter((id) => id === a || id === b);
  assert.deepEqual(survivors, [b, a]);
  assert.ok(S().windows[other]);
});

test("close undo preserves a newer group assignment without duplicating its survivor", () => {
  const { w, a, b, c } = setup();
  const original = S().createGroup([b, c]);
  useBrowser.setState({ groups: { ...S().groups, [original]: { ...S().groups[original], autoUngroup: true } }, sidebarUndo: {} });
  S().closeTabs([c]);
  const other = S().createWindow();
  const newer = S().groupTabs([a, b], { pinned: false });
  S().undoSidebarEdit(w);
  assert.deepEqual(S().groups[newer].tabIds.sort(), [a, b].sort());
  assert.equal(Object.values(S().groups).filter((g) => g.tabIds.includes(b)).length, 1);
  assert.ok(viewTabIds(S(), other).includes(c));
});

test("undoing a pinned close restores its native history lazily", () => {
  const { w, b } = setup();
  S().pinRows([b], true);
  S().closeTab(b);
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].wakeAdoptId, `restore:${b}`);
  assert.equal(S().tabs[b].navigation, null);
  S().activate(b, w);
  assert.equal(S().tabs[b].adoptId, `restore:${b}`);
});

test("empty folder reordering has a reversible transaction even without record changes", () => {
  const { w } = setup();
  const folders = ["P", "Q", "R"].map((name) => S().newPinnedFolder(w, { name }));
  useBrowser.setState({ sidebarUndo: {} });
  S().movePinnedFolder(folders[0], null, null);
  assert.deepEqual(Object.keys(S().pinnedFolders), [folders[1], folders[2], folders[0]]);
  assert.equal(S().sidebarUndo[w].length, 1);
  S().undoSidebarEdit(w);
  assert.deepEqual(Object.keys(S().pinnedFolders), folders);
});

test("explicit command origin owns the edit even if a different window is focused", async () => {
  const { w, b } = setup();
  const other = S().createWindow();
  const { withSidebarUndoWindow } = await import("./sidebarUndo.ts");
  withSidebarUndoWindow(w, () => S().pinRows([b], true));
  assert.equal(S().sidebarUndo[w].length, 1);
  assert.equal(S().sidebarUndo[other], undefined);
  S().undoSidebarEdit(w);
  assert.ok(!S().tabs[b].pinnedRow);
});

test("undo never moves a surviving tab back to a deleted space", () => {
  const { w, b } = setup();
  const source = S().windows[w].spaceId;
  const destination = S().createSpace({ name: "Destination" });
  S().moveTabToSpace(b, destination);
  S().deleteSpace(source);
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].spaceId, destination);
  assert.ok(viewTabIds(S(), w, destination).includes(b));
});

test("folder undo normalizes cycles and releases later additions when creation is undone", async () => {
  const { w, b } = setup();
  const { folderDepth } = await import("./folders.ts");
  const { withSidebarUndoWindow } = await import("./sidebarUndo.ts");
  const p = S().newPinnedFolder(w, { name: "P" });
  const c = S().newPinnedFolder(w, { name: "C", parentId: p });
  S().movePinnedFolder(c, null, null);
  const other = S().createWindow();
  withSidebarUndoWindow(other, () => S().movePinnedFolder(p, null, c));
  S().undoSidebarEdit(w);
  assert.ok(Number.isFinite(folderDepth(S(), c)) && folderDepth(S(), c) <= 5);
  assert.ok(Number.isFinite(folderDepth(S(), p)) && folderDepth(S(), p) <= 5);
  const later = S().newPinnedFolder(w, { name: "Later" });
  withSidebarUndoWindow(other, () => S().placeTabs([b], { pinned: false, row: true, folderId: later }));
  S().undoSidebarEdit(w);
  assert.equal(S().pinnedFolders[later], undefined);
  assert.equal(S().tabs[b].folderId, undefined);
});

test("undoing unpin removes the tab from a newer group and keeps each row unique", async () => {
  const { w, b, c } = setup();
  const { withSidebarUndoWindow } = await import("./sidebarUndo.ts");
  S().pinRows([b], true);
  S().pinRows([b], false);
  const other = S().createWindow();
  const group = withSidebarUndoWindow(other, () => S().groupTabs([b, c], { pinned: false }));
  S().undoSidebarEdit(w);
  assert.equal(S().tabs[b].pinnedRow, true);
  assert.ok(!S().groups[group]?.tabIds.includes(b));
});

test("undo close repairs active mappings in every affected window", () => {
  const { w, a, b, c } = setup();
  const other = S().createWindow();
  S().activate(b, other);
  S().setFocusedWindow(w);
  S().closeTabs([a, b, c]);
  S().undoSidebarEdit(w);
  for (const window of Object.values(S().windows)) assert.ok(S().tabs[window.activeTabIds[window.spaceId]]);
  assert.equal(S().windows[other].activeTabIds.default, b);
});

test("live-folder names and icons respect explicit window ownership", async () => {
  const { w } = setup();
  const { withSidebarUndoWindow } = await import("./sidebarUndo.ts");
  const { setLive, updateFolder, live } = await import("../live/store.ts");
  const other = S().createWindow();
  setLive({
    folders: {
      lf: { id: "lf", name: "Original", icon: null, spaceId: "default", kind: "documents", sources: [], filters: {}, createdAt: 0, collapsed: false },
    },
  });
  withSidebarUndoWindow(w, () => updateFolder("lf", { icon: "X" }));
  assert.ok(S().sidebarUndo[w]?.length);
  assert.equal(S().sidebarUndo[other], undefined);
  S().undoSidebarEdit(w);
  assert.equal(live().folders.lf.icon, null);
});
