import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { listIds, spaceListKey } from "../store/model.ts";
import { executeImportCommand, parseImportCommand, validateImportReply, IMPORT_PAYLOAD_CHARS } from "./importCommands.ts";

const run = (store, c) => executeImportCommand(store, parseImportCommand(c));
const tab = (name, pinned = false) => ({ url: `https://${name}.example`, title: name, pinned });
function setup() {
  const store = createBrowserStore();
  store.getState().hydrate({});
  const spaceId = store.getState().settings.defaultSpaceId;
  return { store, spaceId };
}

test("imported tabs reduce the supplied store and return exact IDs, excluding a newly created window's initial page", () => {
  const { store, spaceId } = setup();
  const singleton = useBrowser.getState();
  const result = run(store, {
    method: "importTabs",
    spaceId,
    tabs: [tab("one"), tab("two", true), { ...tab("blocked"), url: "chrome://settings" }],
    group: "Imported",
  });
  assert.equal(result.count, 2);
  assert.equal(result.tabIds.length, 2);
  assert.deepEqual(
    result.tabIds.map((id) => store.getState().tabs[id].title),
    ["one", "two"],
  );
  for (const id of result.tabIds) assert.equal(store.getState().tabs[id].navigation, null);
  assert.equal(Object.values(store.getState().groups)[0].name, "Imported");
  assert.strictEqual(useBrowser.getState(), singleton);
  assert.ok(validateImportReply("importTabs", result));
});

test("chunked imports continue unpinned order with new tabs positioned at the top", () => {
  const { store, spaceId } = setup();
  store.getState().updateSettings({ newTabPosition: "top" });
  const first = run(store, { method: "importTabs", spaceId, tabs: [tab("a"), tab("b")], group: null });
  const second = run(store, { method: "importTabs", spaceId, tabs: [tab("c"), tab("d")], group: null, afterId: first.tabIds[1] });
  const ids = listIds(store.getState(), spaceListKey(store.getState(), spaceId));
  assert.deepEqual(
    ids.filter((id) => [...first.tabIds, ...second.tabIds].includes(id)).map((id) => store.getState().tabs[id].title),
    ["a", "b", "c", "d"],
  );
  const other = store.getState().createSpace({ name: "Other" });
  assert.throws(() => run(store, { method: "importTabs", spaceId: other, tabs: [tab("x")], group: null, afterId: first.tabIds[0] }), /another list/);
});

test("bookmark imports merge bars and stream nested folders without losing dates or their IDs", () => {
  const { store, spaceId } = setup();
  const root = {
    type: "folder",
    title: "Root",
    children: [{ type: "folder", title: "Toolbar", role: "toolbar", children: [{ type: "url", title: "First", url: "https://first.example", dateAdded: 12 }] }],
  };
  assert.deepEqual(run(store, { method: "importBookmarks", spaceId, root, browserName: "Chrome" }), { count: 1 });
  const bar = store.getState().bookmarks.roots[spaceId].bar;
  const folder = run(store, {
    method: "importBookmarks",
    spaceId,
    parentId: bar,
    browserName: "Chrome",
    root: { type: "folder", title: "", children: [{ type: "folder", title: "Streamed", dateAdded: 33, children: [] }] },
  });
  assert.equal(folder.count, 0);
  assert.equal(folder.bookmarkIds.length, 1);
  assert.equal(store.getState().bookmarks.nodes[folder.bookmarkIds[0]].addedAt, 33);
  const written = run(store, {
    method: "importBookmarks",
    spaceId,
    parentId: folder.bookmarkIds[0],
    browserName: "Chrome",
    root: { type: "folder", title: "", children: [{ type: "url", title: "Child", url: "https://child.example", dateAdded: 44 }] },
  });
  assert.equal(written.count, 1);
  assert.equal(store.getState().bookmarks.nodes[written.bookmarkIds[0]].addedAt, 44);
  assert.ok(validateImportReply("importBookmarks", written));
  const other = store.getState().createSpace({ name: "Other" });
  assert.throws(
    () => run(store, { method: "importBookmarks", spaceId: other, parentId: bar, browserName: "Chrome", root: { type: "folder", title: "", children: [] } }),
    /this space/,
  );
});

test("history imports retain profile boundaries and report only newly inserted pages", () => {
  const { store, spaceId } = setup();
  const c = { method: "importHistory", spaceId, entries: [{ url: "https://one.example", title: "One", visits: 2, lastVisit: 500 }] };
  assert.deepEqual(run(store, c), { count: 1 });
  assert.deepEqual(run(store, c), { count: 0 });
  const other = store.getState().createSpace({ name: "Other" });
  assert.deepEqual(run(store, { ...c, spaceId: other }), { count: 1 });
  assert.equal(store.getState().history[spaceId].length, 1);
  assert.equal(store.getState().history[other].length, 1);
});

test("Dia filters existing URLs and Arc keeps overflow pinned tabs in five folder levels", () => {
  const { store, spaceId } = setup();
  run(store, { method: "importTabs", spaceId, tabs: [tab("existing")], group: null });
  const dia = run(store, {
    method: "importDiaProfile",
    spaceId,
    profile: { pinned: [tab("existing", true), tab("new", true)], tabs: [tab("open")] },
    what: { pinned: true, open: true },
  });
  assert.equal(dia.count, 2);
  let pinned = [{ type: "url", title: "Deep", url: "https://deep.example" }];
  for (let i = 0; i < 80; i++) pinned = [{ type: "folder", title: `Level ${i}`, children: pinned }];
  assert.equal(run(store, { method: "importArcSpace", spaceId, space: { pinned, tabs: [] } }).count, 1);
  assert.equal(Object.keys(store.getState().pinnedFolders).length, 5);
  assert.ok(Object.values(store.getState().tabs).some((t) => t.title === "Deep" && t.pinnedRow));
});

test("import parsers reject secrets, malformed records, oversized batches and private destinations", () => {
  const { store, spaceId } = setup();
  const c = { method: "importTabs", spaceId, tabs: [tab("one")], group: null };
  for (const bad of [
    { ...c, password: "secret" },
    { ...c, tabs: [{ ...tab("one"), adoptId: "raw" }] },
    { ...c, tabs: [{ ...tab("one"), pinned: "yes" }] },
    { ...c, afterId: "" },
  ])
    assert.throws(() => parseImportCommand(bad));
  assert.throws(() => parseImportCommand({ ...c, tabs: [{ ...tab("one"), url: "x".repeat(IMPORT_PAYLOAD_CHARS) }] }), /too large/);
  for (const destination of ["missing", "incognito:window"]) assert.throws(() => run(store, { ...c, spaceId: destination }), /space no longer/);
  assert.equal(validateImportReply("importTabs", { count: 2, tabIds: ["a", "a"] }), false);
  assert.equal(validateImportReply("importHistory", { count: 1, tabIds: ["secret"] }), false);
  assert.equal(validateImportReply("importTabs", { count: 1, tabIds: [] }), false);
  assert.equal(validateImportReply("importHistory", { count: -1 }), false);
});
