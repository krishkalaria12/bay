import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKMARK_LIMIT,
  BOOKMARKS_ROOT,
  bookmarkChildren,
  bookmarkLinks,
  bookmarkPath,
  draftNodes,
  emptyBookmarks,
  folderLinkCount,
  isBookmarked,
  parseBookmarks,
} from "../src/store/bookmarks.ts";
import { createTab, initialBrowserData, mergeHistory, parseBrowserData, reduceBrowserData } from "../src/store/model.ts";
import type { JsonValue } from "../src/store/types.ts";

const ids = () => {
  let next = 0;

  return () => `b${++next}`;
};

const fresh = () => initialBrowserData(createTab("t", 0));

const DRAFTS = [
  {
    title: "Safari",
    children: [
      { title: "Apple", url: "https://www.apple.com/", addedAt: 5 },
      { title: "Recipes", children: [{ title: "Soup", url: "https://soup.example/" }] },
    ],
  },
];

test("drafts become one tree under the folder they're added to", () => {
  const nodes = draftNodes(DRAFTS, BOOKMARKS_ROOT, ids(), 100, BOOKMARK_LIMIT);
  const data = reduceBrowserData(fresh(), { type: "add-bookmarks", nodes });
  const [safari] = bookmarkChildren(data.bookmarks, BOOKMARKS_ROOT);

  assert.equal(safari?.title, "Safari");
  assert.deepEqual(
    bookmarkLinks(data.bookmarks).map((link) => [link.title, link.addedAt]),
    [
      ["Apple", 5],
      ["Soup", 100],
    ],
  );
  assert.equal(folderLinkCount(data.bookmarks, safari!.id), 2);
  const recipes = bookmarkChildren(data.bookmarks, safari!.id)[1]!;
  assert.deepEqual(
    bookmarkPath(data.bookmarks, recipes.id).map((folder) => folder.title),
    ["Safari", "Recipes"],
  );
});

test("a draft past the room left is dropped, with everything in it", () => {
  const nodes = draftNodes(DRAFTS, BOOKMARKS_ROOT, ids(), 0, 3);

  assert.deepEqual(
    nodes.map((node) => node.title),
    ["Safari", "Apple", "Recipes"],
  );
  assert.deepEqual(nodes[2]?.kind === "folder" && nodes[2].children, []);
});

test("removing a folder removes everything in it and leaves its parent's list", () => {
  let data = reduceBrowserData(fresh(), { type: "add-bookmarks", nodes: draftNodes(DRAFTS, BOOKMARKS_ROOT, ids(), 0, BOOKMARK_LIMIT) });
  const safari = bookmarkChildren(data.bookmarks, BOOKMARKS_ROOT)[0]!;
  data = reduceBrowserData(data, { type: "remove-bookmark", id: safari.id });

  assert.deepEqual(data.bookmarks, emptyBookmarks());
  assert.equal(reduceBrowserData(data, { type: "remove-bookmark", id: BOOKMARKS_ROOT }), data);
});

test("toggling a page bookmarks it at the top level, and toggling again removes every copy", () => {
  let data = reduceBrowserData(fresh(), { type: "add-bookmarks", nodes: draftNodes(DRAFTS, BOOKMARKS_ROOT, ids(), 0, BOOKMARK_LIMIT) });
  const page = { kind: "url" as const, id: "page", parentId: BOOKMARKS_ROOT, title: "Soup again", url: "https://soup.example/", addedAt: 9 };

  // Already bookmarked inside Recipes: the toggle removes it.
  data = reduceBrowserData(data, { type: "toggle-bookmark", bookmark: page });
  assert.equal(isBookmarked(data.bookmarks, page.url), false);

  data = reduceBrowserData(data, { type: "toggle-bookmark", bookmark: page });
  assert.equal(bookmarkChildren(data.bookmarks, BOOKMARKS_ROOT).at(-1)?.id, "page");
  assert.equal(reduceBrowserData(data, { type: "toggle-bookmark", bookmark: { ...page, id: "x", url: "javascript:1" } }), data);
});

test("the tree stops at the limit", () => {
  const drafts = Array.from({ length: 10 }, (_, index) => ({ title: `${index}`, url: `https://${index}.example/` }));

  const full = Object.fromEntries(
    Array.from({ length: BOOKMARK_LIMIT - 3 }, (_, index) => [
      `f${index}`,
      { kind: "url" as const, id: `f${index}`, parentId: BOOKMARKS_ROOT, title: "", url: "https://f.example/", addedAt: 0 },
    ]),
  );

  const data = { ...fresh(), bookmarks: { ...emptyBookmarks(), ...full } };
  const after = reduceBrowserData(data, { type: "add-bookmarks", nodes: draftNodes(drafts, BOOKMARKS_ROOT, ids(), 0, BOOKMARK_LIMIT) });

  assert.equal(Object.keys(after.bookmarks).length, BOOKMARK_LIMIT);
});

test("saved bookmarks are repaired: only what the root reaches, each node once, bad nodes and cycles left out", () => {
  const saved: JsonValue = {
    bookmarks: { kind: "folder", id: "bookmarks", title: "", children: ["a", "f", "a", "missing", "bad"], addedAt: 0 },
    a: { kind: "url", id: "a", title: "A", url: "https://a.example/", addedAt: 1 },
    f: { kind: "folder", id: "f", title: "F", children: ["b", "f", "bookmarks"], addedAt: 2 },
    b: { kind: "url", id: "b", title: "B", url: "https://b.example/", addedAt: 3 },
    bad: { kind: "url", id: "bad", title: "Bad", url: "javascript:alert(1)", addedAt: 4 },
    orphan: { kind: "url", id: "orphan", title: "Orphan", url: "https://o.example/", addedAt: 5 },
  };

  const bookmarks = parseBookmarks(saved);

  assert.deepEqual(Object.keys(bookmarks).sort(), ["a", "b", "bookmarks", "f"]);
  assert.deepEqual(bookmarks[BOOKMARKS_ROOT]?.kind === "folder" && bookmarks[BOOKMARKS_ROOT].children, ["a", "f"]);
  assert.deepEqual(bookmarks.f?.kind === "folder" && bookmarks.f.children, ["b"]);
  assert.equal(bookmarks.b?.parentId, "f");
});

test("a document saved before bookmarks existed reads with none, and bookmarks survive a save and read", () => {
  const before = parseBrowserData({ version: 2, tabs: [] }, fresh());
  assert.deepEqual(before.bookmarks, emptyBookmarks());

  const data = reduceBrowserData(fresh(), { type: "add-bookmarks", nodes: draftNodes(DRAFTS, BOOKMARKS_ROOT, ids(), 0, BOOKMARK_LIMIT) });
  // SAFETY: the browsing state is made of JSON values, which is what the round trip through JSON checks.
  const read = parseBrowserData(JSON.parse(JSON.stringify({ version: 2, ...data })) as JsonValue, fresh());
  assert.deepEqual(read.bookmarks, data.bookmarks);
});

test("imported history adds visits to the pages already there and keeps the newest, up to the limit", () => {
  const history = [{ url: "https://a.example/", title: "Mine", favicon: null, visits: 2, lastVisit: 50 }];

  const merged = mergeHistory(history, [
    { url: "https://a.example/", title: "Theirs", favicon: null, visits: 3, lastVisit: 80 },
    { url: "https://b.example/", title: "B", favicon: null, visits: 1, lastVisit: 60 },
    { url: "ftp://c.example/", title: "C", favicon: null, visits: 1, lastVisit: 70 },
  ]);

  assert.deepEqual(merged, [
    { url: "https://a.example/", title: "Mine", favicon: null, visits: 5, lastVisit: 80 },
    { url: "https://b.example/", title: "B", favicon: null, visits: 1, lastVisit: 60 },
  ]);
  assert.equal(mergeHistory(history, []), history);

  const many = Array.from({ length: 1500 }, (_, index) => ({ url: `https://${index}.example/`, title: "", favicon: null, visits: 1, lastVisit: index }));
  assert.equal(mergeHistory([], many).length, 1000);
  assert.equal(mergeHistory([], many)[0]?.lastVisit, 1499);
});

test("imported pins join after the ones already there, once each", () => {
  let data = reduceBrowserData(fresh(), {
    type: "add-pin",
    site: { id: "p", url: "https://a.example/", title: "A", favicon: null, spaceId: "personal", kind: "essential", folderId: null },
    index: 0,
  });

  data = reduceBrowserData(data, {
    type: "import-pins",
    sites: [
      { id: "1", url: "https://a.example/", title: "A again", favicon: null },
      { id: "2", url: "https://b.example/", title: "B", favicon: null },
      { id: "3", url: "https://b.example/", title: "B twice", favicon: null },
    ],
  });

  assert.deepEqual(
    data.pinnedSites.map((site) => site.id),
    ["p", "2"],
  );
});
