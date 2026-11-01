import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../../store/browser.ts");
const { folderEntries, sidebarEntries, sidebarTabOrder, numberedTabs } = await import("./entries.ts");
const { entryHeight, folderDragItemVisible, keptEntry, rowSpan } = await import("./geometry.ts");
const { DEFAULT_SETTINGS } = await import("../../store/settings.ts");
const { childFolderIds, folderTabIds } = await import("../../store/folders.ts");
DEFAULT_SETTINGS.newTabPosition = "bottom";
const S = () => useBrowser.getState();

function fixture() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://loose.example" });
  const loose = S().windows[w].activeTabIds.default;
  const a = S().newTab(w, { url: "https://parent.example" });
  const b = S().newTab(w, { url: "https://nested.example" });
  const c = S().newTab(w, { url: "https://last.example" });
  S().pinRows([loose, c], true);
  const parent = S().newPinnedFolder(w, { name: "Work", tabIds: [a] });
  const child = S().newPinnedFolder(w, { name: "Research", parentId: parent, tabIds: [b] });
  const empty = S().newPinnedFolder(w, { name: "Empty", parentId: child });
  return { w, loose, a, b, c, parent, child, empty };
}

test("folder membership caches progress/UI reads and invalidates placement, lists and hierarchy", () => {
  const f = fixture();
  const members = folderTabIds(S(), f.parent);
  assert.deepEqual(members, [f.a, f.b]);
  assert.deepEqual(folderTabIds(S(), f.parent, false), [f.a]);
  S().updateLive(f.b, { progress: 0.4 });
  S().setSelection(f.w, [f.a]);
  S().toggleSidebar(f.w);
  assert.strictEqual(folderTabIds(S(), f.parent), members);
  const state = S();
  const check = (patch, expected, direct) => {
    const s = { ...state, ...patch };
    assert.deepEqual(folderTabIds(s, f.parent), expected);
    assert.deepEqual(folderTabIds(s, f.parent, false), direct);
    assert.strictEqual(folderTabIds(s, f.parent), folderTabIds(s, f.parent));
  };
  check({ tabs: { ...state.tabs, [f.b]: { ...state.tabs[f.b], folderId: f.parent } } }, [f.a, f.b], [f.a, f.b]);
  check({ tabs: { ...state.tabs, [f.b]: { ...state.tabs[f.b], pinnedRow: false } } }, [f.a], [f.a]);
  check({ tabs: { ...state.tabs, [f.b]: { ...state.tabs[f.b], spaceId: "other" } } }, [f.a], [f.a]);
  check({ tabs: { ...state.tabs, [f.b]: undefined } }, [f.a], [f.a]);
  check({ tabLists: { ...state.tabLists, default: [...state.tabLists.default].reverse() } }, [f.b, f.a], [f.a]);
  check({ pinnedFolders: { ...state.pinnedFolders, [f.child]: { ...state.pinnedFolders[f.child], parentId: undefined } } }, [f.a], [f.a]);
  check({ pinnedFolders: { ...state.pinnedFolders, [f.parent]: { ...state.pinnedFolders[f.parent], spaceId: "other" } } }, [], []);
  const gone = { ...state.pinnedFolders };
  delete gone[f.parent];
  assert.deepEqual(folderTabIds({ ...state, pinnedFolders: gone }, f.parent), []);
  const children = childFolderIds(state, f.parent);
  assert.deepEqual(children, [f.child]);
  assert.strictEqual(childFolderIds(state, f.parent), children);
  assert.deepEqual(
    childFolderIds({ pinnedFolders: { ...state.pinnedFolders, [f.child]: { ...state.pinnedFolders[f.child], parentId: undefined } } }, f.parent),
    [],
  );
});

test("folder membership preserves list order and safely handles cyclic or cross-space ancestors", () => {
  const pinnedFolders = {
    a: { id: "a", spaceId: "default", parentId: "b" },
    b: { id: "b", spaceId: "other", parentId: "a" },
    c: { id: "c", spaceId: "default", parentId: "b" },
  };
  const state = {
    pinnedFolders,
    spaces: {},
    tabLists: { default: ["c", "b", "a", "missing"], other: ["b"] },
    tabs: {
      a: { id: "a", spaceId: "default", pinnedRow: true, folderId: "a" },
      b: { id: "b", spaceId: "other", pinnedRow: true, folderId: "b" },
      c: { id: "c", spaceId: "default", pinnedRow: true, folderId: "c" },
      missing: { id: "missing", spaceId: "default", pinnedRow: true, folderId: "gone" },
    },
  };
  assert.deepEqual(folderTabIds(state, "a"), ["c", "a"]);
  assert.deepEqual(folderTabIds(state, "a", false), ["a"]);
  assert.deepEqual(folderTabIds(state, "b"), ["b"]);
  assert.deepEqual(folderTabIds(state, "c"), ["c"]);
});

test("nested pinned entries appear once at each level, including empty children", () => {
  const { w, parent, child, empty, a, b, loose, c } = fixture();
  assert.deepEqual(
    sidebarEntries(S(), w).pinned.filter((e) => e.startsWith("f:")),
    [`f:${parent}`],
  );
  assert.deepEqual(folderEntries(S(), parent), [`t:${a}`, `f:${child}`]);
  assert.deepEqual(folderEntries(S(), child), [`t:${b}`, `f:${empty}`]);
  assert.deepEqual(folderEntries(S(), empty), []);
  assert.deepEqual(sidebarTabOrder(S(), w), [loose, c, a, b]);
  assert.deepEqual(numberedTabs(S(), w), [loose, c, a, b]);
});

test("nested reveal geometry and active leaf remain consistent through collapse", () => {
  const { w, b, parent, child, loose } = fixture();
  S().activate(b, w);
  const rootTop = rowSpan(S(), w, "default", b, false).top;
  const rowHeight = entryHeight(S(), w, "default", `t:${b}`);
  const openHeight = entryHeight(S(), w, "default", `f:${parent}`);
  S().updatePinnedFolder(child, { collapsed: true });
  assert.equal(rowSpan(S(), w, "default", b, false).top, rootTop);
  assert.ok(entryHeight(S(), w, "default", `f:${parent}`) < openHeight);
  S().updatePinnedFolder(parent, { collapsed: true });
  assert.equal(keptEntry(S(), w, "default", folderEntries(S(), parent)), `f:${child}`);
  assert.ok(rowSpan(S(), w, "default", b, false).top < rootTop);
  assert.equal(entryHeight(S(), w, "default", `f:${parent}`), rowHeight * 2 + 2);
  S().activate(loose, w);
  assert.equal(entryHeight(S(), w, "default", `f:${parent}`), rowHeight);
});

test("empty nested folders follow their model order after a reorder", () => {
  const { w, parent } = fixture();
  const first = S().newPinnedFolder(w, { name: "First", parentId: parent });
  const second = S().newPinnedFolder(w, { name: "Second", parentId: parent });
  S().movePinnedFolder(second, first, parent);
  const folders = folderEntries(S(), parent).filter((e) => e === `f:${first}` || e === `f:${second}`);
  assert.deepEqual(folders, [`f:${second}`, `f:${first}`]);
});

test("an empty folder keeps a drop anchor before populated siblings and loose rows", () => {
  const { w, parent, child, loose } = fixture();
  const empty = S().newPinnedFolder(w, { name: "Inbox", parentId: parent });
  S().movePinnedFolder(empty, child, parent);
  const nested = folderEntries(S(), parent);
  assert.equal(nested.indexOf(`f:${empty}`) + 1, nested.indexOf(`f:${child}`));
  S().movePinnedFolder(empty, loose, null);
  const root = sidebarEntries(S(), w).pinned;
  assert.equal(root.indexOf(`f:${empty}`) + 1, root.indexOf(`t:${loose}`));
  S().undoPinnedFolderMove();
  assert.ok(folderEntries(S(), parent).includes(`f:${empty}`));
});

test("collapsed selected branches cannot become drag targets while their views stay mounted", () => {
  const { w, parent, child, a, b } = fixture();
  S().activate(b, w);
  S().setSelection(w, [a, b]);
  S().updatePinnedFolder(parent, { collapsed: true });
  assert.equal(folderDragItemVisible(S(), w, { kind: "folder", parentGroup: parent, tabIds: [b] }), false);
  assert.equal(folderDragItemVisible(S(), w, { kind: "row", parentGroup: parent, tabIds: [a] }), false);
  assert.equal(folderDragItemVisible(S(), w, { kind: "tail", parentGroup: child, tabIds: [] }), false);
  assert.equal(folderDragItemVisible(S(), w, { kind: "row", parentGroup: child, tabIds: [b] }), true, "the visible active leaf remains a target");
  assert.equal(folderDragItemVisible(S(), w, { kind: "folder", tabIds: [a, b] }), true, "the collapsed parent header stays visible");
  S().updatePinnedFolder(parent, { collapsed: false });
  assert.equal(folderDragItemVisible(S(), w, { kind: "folder", parentGroup: parent, tabIds: [b] }), true);
});
