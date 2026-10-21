import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { createBrowserAuthority } from "./authority.ts";
import { BOOKMARK_COMMAND_METHODS, executeBookmarkCommand, parseBookmarkCommand } from "./bookmarkCommands.ts";
import { executeHistoryCommand, HISTORY_COMMAND_METHODS, parseHistoryCommand } from "./historyCommands.ts";
import { browserCommandResultKind } from "./userCommands.ts";

const run = (store, command) => executeBookmarkCommand(store, parseBookmarkCommand(command));
function setup() {
  const store = createBrowserStore();
  const s = () => store.getState();
  const page = run(store, { method: "addBookmark", options: { spaceId: "default", url: "https://a.example/", title: "A" } });
  const folder = run(store, { method: "addBookmarkFolder", options: { spaceId: "default", title: "Folder" } });
  const roots = s().bookmarks.roots.default;
  return { store, s, page, folder, roots };
}

test("bookmark and history parsers close every command and nested object", () => {
  const commands = [
    { method: "addBookmark", options: { spaceId: "s", url: "u", title: "t", favicon: null, parentId: "p", index: 0 } },
    { method: "addBookmarkFolder", options: { spaceId: "s", title: "t", parentId: "p", index: 1 } },
    {
      method: "addBookmarkTree",
      spaceId: "s",
      drafts: [{ title: "f", children: [{ title: "p", url: "u", addedAt: 1_700_000_000_000 }] }],
      parentId: "p",
      index: 0,
    },
    { method: "updateBookmark", bookmarkId: "b", patch: { title: "t", url: "u", favicon: "data:," } },
    { method: "moveBookmark", bookmarkId: "b", parentId: "p", index: 2 },
    { method: "removeBookmark", bookmarkId: "b" },
    { method: "toggleBookmark", spaceId: "s", page: { url: "u", title: "t", favicon: null } },
    { method: "removeBookmarks", spaceId: "s", bookmarkIds: ["a", "b"] },
    { method: "restoreBookmarks", undoId: "u" },
  ];
  assert.deepEqual(new Set(commands.map((c) => c.method)), new Set(BOOKMARK_COMMAND_METHODS));
  for (const command of commands) {
    const parsed = parseBookmarkCommand(command);
    assert.deepEqual(parsed, command);
    assert.notEqual(parsed, command);
    assert.throws(() => parseBookmarkCommand({ ...command, native: true }), { code: "invalid_request" });
    for (const key of ["options", "patch", "page"])
      if (command[key]) assert.throws(() => parseBookmarkCommand({ ...command, [key]: { ...command[key], syncKey: "x" } }), { code: "invalid_request" });
  }
  for (const command of [
    { method: "removeBookmarksWithUndo", spaceId: "s", bookmarkIds: [] },
    { method: "addBookmarkTree", spaceId: "s", drafts: [{ title: "x", url: "u", children: [] }] },
    { method: "addBookmarkTree", spaceId: "s", drafts: [{ title: "x", favicon: "f" }] },
    { method: "addBookmarkTree", spaceId: "s", drafts: [{ title: "x", addedAt: -1 }] },
    { method: "toggleBookmark", spaceId: "s", page: { url: "u", title: "t", favicon: null, pinned: true } },
    { method: "removeBookmarks", spaceId: "s", bookmarkIds: ["a", "a"] },
  ])
    assert.throws(() => parseBookmarkCommand(command), { code: "invalid_request" }, JSON.stringify(command));
  let deep = [{ title: "leaf", url: "u" }];
  for (let i = 0; i < 20; i++) deep = [{ title: `f${i}`, children: deep }];
  assert.throws(() => parseBookmarkCommand({ method: "addBookmarkTree", spaceId: "s", drafts: deep }), { code: "invalid_request" });

  const history = [
    { method: "removeHistory", spaceId: "s", urls: ["https://a.example/"] },
    { method: "clearHistory", spaceId: "s", since: 1_700_000_000_000 },
  ];
  assert.deepEqual(new Set(history.map((c) => c.method)), new Set(HISTORY_COMMAND_METHODS));
  for (const command of history) assert.deepEqual(parseHistoryCommand(command), command);
  for (const command of [
    { method: "removeHistory", spaceId: "s", urls: [] },
    { method: "clearHistory", spaceId: "s", since: -1 },
    { method: "importHistory", spaceId: "s", entries: [] },
  ])
    assert.throws(() => parseHistoryCommand(command), { code: "invalid_request" }, JSON.stringify(command));

  for (const method of ["addBookmark", "addBookmarkFolder"]) assert.equal(browserCommandResultKind(method), "id");
  assert.equal(browserCommandResultKind("removeBookmarks"), "optionalId");
});

test("bookmark commands add, edit, move, toggle and remove within a space's tree", () => {
  const { store, s, page, folder, roots } = setup();
  assert.equal(s().bookmarks.nodes[page].parentId, roots.bar);
  run(store, { method: "updateBookmark", bookmarkId: page, patch: { title: "Renamed" } });
  assert.equal(s().bookmarks.nodes[page].title, "Renamed");
  run(store, { method: "moveBookmark", bookmarkId: page, parentId: folder });
  assert.equal(s().bookmarks.nodes[page].parentId, folder);
  run(store, { method: "moveBookmark", bookmarkId: page, parentId: roots.other, index: 0 });
  assert.equal(s().bookmarks.nodes[page].parentId, roots.other);
  run(store, {
    method: "addBookmarkTree",
    spaceId: "default",
    drafts: [{ title: "Tabs", children: [{ title: "B", url: "https://b.example/" }] }],
    parentId: folder,
  });
  assert.equal(s().bookmarks.nodes[folder].children.length, 1);

  const page2 = { url: "https://c.example/", title: "C", favicon: null };
  run(store, { method: "toggleBookmark", spaceId: "default", page: page2 });
  assert.ok(Object.values(s().bookmarks.nodes).some((n) => n.url === page2.url));
  run(store, { method: "toggleBookmark", spaceId: "default", page: page2 });
  assert.ok(!Object.values(s().bookmarks.nodes).some((n) => n.url === page2.url));
  run(store, { method: "removeBookmark", bookmarkId: page });
  assert.equal(s().bookmarks.nodes[page], undefined);
});

test("removed bookmarks come back from the coordinator's undo entry in one commit", async () => {
  const { store, s, page, folder } = setup();
  const authority = createBrowserAuthority({ epoch: "bookmarks", store });
  const commits = [];
  authority.subscribe((commit) => commits.push(commit.revision));
  const dispatch = (requestId, command) => authority.dispatch({ epoch: "bookmarks", clientId: "w", requestId, command });
  const undoId = (await dispatch(1, { method: "removeBookmarks", spaceId: "default", bookmarkIds: [page, folder] })).value;
  assert.equal(typeof undoId, "string");
  assert.equal(s().bookmarks.nodes[page], undefined);
  assert.equal(s().bookmarkUndo.length, 1);
  assert.equal((await dispatch(2, { method: "removeBookmarks", spaceId: "default", bookmarkIds: [] })).value, null, "nothing removed has no undo");
  await dispatch(3, { method: "restoreBookmarks", undoId });
  assert.ok(s().bookmarks.nodes[page] && s().bookmarks.nodes[folder]);
  assert.deepEqual(s().bookmarkUndo, []);
  assert.deepEqual(commits, [1, 2], "the empty removal changed nothing to publish");
  await assert.rejects(dispatch(4, { method: "restoreBookmarks", undoId }), { code: "invalid_request" });
  authority.close();
});

test("bookmark and history commands stay within existing public spaces", () => {
  const { store, s, page, roots } = setup();
  const privateWindow = s().createWindow({ incognito: true });
  const privateSpace = s().windows[privateWindow].spaceId;
  const work = s().createSpace({ name: "Work" });
  const workPage = s().addBookmark({ spaceId: work, url: "https://w.example/", title: "W" });
  // Chrome's own private tree: projected to its window only, never a command's target.
  store.setState((state) => ({
    bookmarks: {
      nodes: { ...state.bookmarks.nodes, "private-bar": { kind: "folder", id: "private-bar", parentId: null, title: "Bar", children: [], addedAt: 0 } },
      roots: { ...state.bookmarks.roots, [privateSpace]: { bar: "private-bar", other: "private-bar" } },
    },
  }));
  for (const command of [
    { method: "addBookmark", options: { spaceId: privateSpace, url: "u", title: "t" } },
    { method: "addBookmark", options: { spaceId: "missing", url: "u", title: "t" } },
    { method: "addBookmark", options: { spaceId: "default", url: "u", title: "t", parentId: "private-bar" } },
    { method: "addBookmarkFolder", options: { spaceId: "default", title: "t", parentId: page } },
    { method: "addBookmarkTree", spaceId: work, drafts: [], parentId: roots.bar },
    { method: "updateBookmark", bookmarkId: roots.bar, patch: { title: "Renamed root" } },
    { method: "updateBookmark", bookmarkId: "private-bar", patch: { title: "x" } },
    { method: "moveBookmark", bookmarkId: page, parentId: s().bookmarks.roots[work].bar },
    { method: "moveBookmark", bookmarkId: roots.other, parentId: roots.bar },
    { method: "removeBookmark", bookmarkId: roots.bar },
    { method: "toggleBookmark", spaceId: privateSpace, page: { url: "u", title: "t", favicon: null } },
    { method: "removeBookmarks", spaceId: "default", bookmarkIds: [page, workPage] },
    { method: "restoreBookmarks", undoId: "missing" },
  ]) {
    const before = s();
    assert.throws(() => run(store, command), { code: "invalid_request" }, JSON.stringify(command));
    assert.equal(s(), before, JSON.stringify(command));
  }
  for (const command of [
    { method: "removeHistory", spaceId: privateSpace, urls: ["u"] },
    { method: "clearHistory", spaceId: "missing" },
  ]) {
    const before = s();
    assert.throws(() => executeHistoryCommand(store, parseHistoryCommand(command)), { code: "invalid_request" });
    assert.equal(s(), before);
  }
  executeHistoryCommand(store, parseHistoryCommand({ method: "clearHistory", spaceId: "default" }));
  assert.deepEqual(s().history.default, []);
});
