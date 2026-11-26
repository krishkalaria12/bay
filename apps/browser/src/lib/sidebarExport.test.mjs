import assert from "node:assert/strict";
import { test } from "node:test";
import { bookmarksHtml, bookmarksJson, exportedSpace } from "./sidebarExport.ts";

const tab = (id, patch) => ({ id, spaceId: "s", url: "", title: "", pinned: false, customTitle: null, pinnedUrl: null, ...patch });

const state = {
  spaces: { s: { id: "s", name: "Work <1>" } },
  tabLists: { s: ["e", "r", "f1", "f2", "open", "bay"] },
  tabs: {
    e: tab("e", { pinned: true, url: "https://mail.example/", title: "Mail" }),
    r: tab("r", { pinnedRow: true, url: "https://docs.example/a", pinnedUrl: "https://docs.example/", title: "Doc", customTitle: "Docs" }),
    f1: tab("f1", { pinnedRow: true, folderId: "top", url: "https://a.example/", title: "A & B" }),
    f2: tab("f2", { pinnedRow: true, folderId: "inner", url: "https://b.example/", title: "B" }),
    open: tab("open", { url: "https://unpinned.example/" }),
    bay: tab("bay", { pinnedRow: true, url: "bay://settings", title: "Settings" }),
  },
  pinnedFolders: {
    top: { id: "top", spaceId: "s", name: "Projects", icon: null, collapsed: false, createdAt: 0 },
    inner: { id: "inner", parentId: "top", spaceId: "s", name: "Inner", icon: null, collapsed: false, createdAt: 0 },
  },
};

test("a space exports its Essentials, folders and pinned tabs in sidebar order, at their pinned pages", () => {
  const space = exportedSpace(state, "s");
  assert.deepEqual(space.essentials, [{ kind: "link", title: "Mail", url: "https://mail.example/" }]);
  assert.deepEqual(space.pinned, [
    {
      kind: "folder",
      title: "Projects",
      items: [
        { kind: "folder", title: "Inner", items: [{ kind: "link", title: "B", url: "https://b.example/" }] },
        { kind: "link", title: "A & B", url: "https://a.example/" },
      ],
    },
    { kind: "link", title: "Docs", url: "https://docs.example/" },
  ]);
});

test("bookmarks HTML nests each space and escapes names", () => {
  const html = bookmarksHtml([exportedSpace(state, "s")]);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<H3>Work &lt;1&gt;<\/H3>/);
  assert.match(html, /<H3>Essentials<\/H3>/);
  assert.match(html, /<A HREF="https:\/\/a.example\/">A &amp; B<\/A>/);
  assert.doesNotMatch(html, /unpinned|bay:\/\//);
  assert.equal(JSON.parse(bookmarksJson([exportedSpace(state, "s")])).spaces[0].name, "Work <1>");
});
