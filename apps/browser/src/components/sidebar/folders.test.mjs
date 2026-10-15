import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../../store/browser.ts");
const { folderEntries, sidebarEntries, sidebarTabOrder, numberedTabs } = await import("./entries.ts");
const { entryHeight, folderDragItemVisible, keptEntry, rowSpan } = await import("./geometry.ts");
const { DEFAULT_SETTINGS } = await import("../../store/settings.ts");
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
