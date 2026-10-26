import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSharedCollection, encodeSharedCollection } from "@bay/core";
const { useBrowser } = await import("./browser.ts");
const { folderTabIds, childFolderIds } = await import("./folders.ts");
const S = () => useBrowser.getState();
const link = (n) => ({ kind: "link", title: `Page ${n} 日本語`, url: `https://example.com/page/${n}` });
const shared = (children, kind = "folder") => ({ version: 1, kind, title: "Research 📚", children });

function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://existing.example" });
  return { w, spaceId: S().windows[w].spaceId, active: S().windows[w].activeTabIds[S().windows[w].spaceId] };
}

test("a compressed 30-tab nested collection imports saved rows in order without loading websites", () => {
  const { w, spaceId, active } = setup();
  const collection = shared([
    ...Array.from({ length: 10 }, (_, n) => link(n)),
    { kind: "folder", title: "Nested", children: Array.from({ length: 20 }, (_, n) => link(n + 10)) },
  ]);
  const folder = S().importSharedCollection(w, decodeSharedCollection(encodeSharedCollection(collection)));
  assert.equal(S().pinnedFolders[folder].name, collection.title);
  const [nested] = childFolderIds(S(), folder);
  assert.equal(S().pinnedFolders[nested].name, "Nested");
  const ids = folderTabIds(S(), folder);
  assert.equal(ids.length, 30);
  assert.deepEqual(
    ids.map((id) => S().tabs[id].url),
    Array.from({ length: 30 }, (_, n) => link(n).url),
  );
  assert.deepEqual(folderTabIds(S(), nested), ids.slice(10));
  for (const id of ids) {
    const tab = S().tabs[id];
    assert.equal(tab.pinnedRow, true);
    assert.equal(tab.navigation, null);
    assert.equal(tab.unloaded, true);
    assert.equal(tab.pinnedUrl, tab.url);
    assert.equal(tab.spaceId, spaceId);
  }
  assert.equal(S().windows[w].activeTabIds[spaceId], active);
  assert.equal(S().sidebarUndo[w].length, 1);
  assert.equal(S().undoSidebarEdit(w), true);
  assert.equal(S().pinnedFolders[folder], undefined);
  assert.equal(S().pinnedFolders[nested], undefined);
  ids.forEach((id) => assert.equal(S().tabs[id], undefined));
  assert.ok(S().tabs[active]);
});

test("empty nested folders retain anchors around direct rows and sibling folders", () => {
  const { w } = setup();
  const folder = S().importSharedCollection(
    w,
    shared([
      { kind: "folder", title: "First empty", children: [] },
      link(1),
      { kind: "folder", title: "Middle empty", children: [] },
      { kind: "folder", title: "Populated", children: [link(2)] },
      { kind: "folder", title: "Last empty", children: [] },
    ]),
  );
  const [first, middle, populated, last] = childFolderIds(S(), folder);
  const [a] = folderTabIds(S(), folder, false);
  assert.equal(S().pinnedFolders[first].beforeId, a);
  assert.equal(S().pinnedFolders[middle].beforeId, populated);
  assert.equal(S().pinnedFolders[populated].beforeId, last);
  assert.equal(S().pinnedFolders[last].beforeId, undefined);
});

test("Undo removes the whole import after an imported tab is opened and reports its page", () => {
  const { w, active, spaceId } = setup();
  const folder = S().importSharedCollection(w, shared([link(1), link(2)]));
  const ids = folderTabIds(S(), folder);
  S().activate(ids[0], w);
  S().updateTab(ids[0], { title: "Loaded page", favicon: "loaded icon", url: "https://example.com/redirect", navigation: null });
  assert.equal(S().undoSidebarEdit(w), true);
  assert.equal(S().pinnedFolders[folder], undefined);
  ids.forEach((id) => assert.equal(S().tabs[id], undefined));
  assert.equal(S().windows[w].activeTabIds[spaceId], active);
});

test("split and selected tab snapshots import as independent folders and preserve their order", () => {
  const { w } = setup();
  for (const kind of ["split", "selection"]) {
    const collection = shared([link(8), link(3)], kind);
    const folder = S().importSharedCollection(w, collection);
    assert.deepEqual(
      folderTabIds(S(), folder).map((id) => S().tabs[id].title),
      collection.children.map((item) => item.title),
    );
  }
  assert.equal(Object.keys(S().splits).length, 0);
});

test("invalid payloads, excessive nesting, and private destinations leave the store untouched", () => {
  const { w } = setup();
  let children = [link(1)];
  for (let i = 0; i < 5; i++) children = [{ kind: "folder", title: "Deep", children }];
  const privateWindow = S().createWindow({ incognito: true });
  const before = S();
  assert.throws(() => S().importSharedCollection(w, shared(children)), /levels deep/);
  assert.throws(() => S().importSharedCollection(w, shared([{ ...link(1), url: "javascript:alert(1)" }])));
  assert.throws(() => S().importSharedCollection(privateWindow, shared([link(1)])), /regular Bay window/);
  assert.throws(() => S().importSharedCollection("missing", shared([link(1)])), /regular Bay window/);
  assert.equal(S(), before);
});

test("an import targets the space confirmed before a later window switch", () => {
  const { w, spaceId } = setup();
  const other = S().createSpace({ name: "Other" });
  S().switchSpace(w, other);
  const folder = S().importSharedCollection(w, shared([link(1)]), spaceId);
  assert.equal(S().pinnedFolders[folder].spaceId, spaceId);
  assert.equal(S().windows[w].spaceId, other);
});
