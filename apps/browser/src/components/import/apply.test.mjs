// An Arc space's pinned tabs and folders land in the Pinned section, not the Essentials or the bookmarks.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { importArcSpace, importWarningNotes } = await import("./apply.ts");
const { sidebarEntries, folderEntries } = await import("../sidebar/entries.ts");
const { folderDepth, folderTabIds } = await import("../../store/folders.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com\/?$/g, "");
const link = (name, title) => ({ type: "url", url: `https://${name}.com`, title: title ?? name });
const folder = (title, ...children) => ({ type: "folder", title, children });

test("partial imports report protected passwords and cards in completion notes", () => {
  const result = {
    credentials: [{ url: "https://saved.test", username: "saved", password: "readable" }],
    failed: [],
    warnings: [
      { kind: "passwords", code: "passwordExportRequired", message: "2 passwords are protected. Export its password CSV and import that file" },
      { kind: "autofill", code: "appBound", message: "Protected payment cards were skipped. Their source browser must export them" },
    ],
  };
  assert.deepEqual(
    importWarningNotes(result),
    result.warnings.map((warning) => `${warning.message}.`),
  );
});

test("completion notes retain skipped-data warnings without duplicating failed categories", () => {
  const result = {
    failed: ["passwords"],
    warnings: [
      { kind: "passwords", code: "passwordExportRequired", message: "Passwords need export" },
      { kind: "autofill", code: "locked", message: "Cards were locked" },
      { kind: "cookies", code: "undecryptable", message: "Cookies could not decrypt" },
      { code: "skipped", message: "Some data was skipped" },
      { code: "info", message: "An informational message" },
    ],
  };
  assert.deepEqual(importWarningNotes(result), ["Cards were locked.", "Cookies could not decrypt.", "Some data was skipped."]);
});

test("an Arc space's pinned tabs become pinned rows and its folders pinned folders, in Arc's order", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.com" });
  const spaceId = S().windows[w].spaceId;
  const bookmarks = Object.keys(S().bookmarks.nodes).length;
  const n = await importArcSpace(spaceId, {
    id: "s",
    name: "Space",
    profileId: "Default",
    pinned: [
      link("a"),
      {
        type: "folder",
        title: "Work",
        children: [link("b"), { type: "folder", title: "Inner", children: [link("c")] }, { type: "url", url: "chrome://x", title: "x" }],
      },
      link("d"),
      { type: "folder", title: "Empty", children: [] },
    ],
    tabs: [{ url: "https://e.com", title: "e", pinned: false, windowIndex: 0, active: false }],
  });
  assert.equal(n, 5);
  const e = sidebarEntries(S(), w);
  assert.deepEqual(e.tiles, []);
  const name = (entry) => (entry.startsWith("f:") ? `[${S().pinnedFolders[entry.slice(2)].name}]` : short(entry.slice(2)));
  assert.deepEqual(e.pinned.map(name), ["a", "[Work]", "d", "[Empty]"]);
  const work = Object.values(S().pinnedFolders).find((f) => f.name === "Work");
  const inner = Object.values(S().pinnedFolders).find((f) => f.name === "Inner");
  assert.equal(inner.parentId, work.id);
  assert.deepEqual(folderTabIds(S(), work.id, false).map(short), ["b"]);
  assert.deepEqual(folderTabIds(S(), inner.id).map(short), ["c"]);
  assert.deepEqual(folderEntries(S(), work.id).map(name), ["b", "[Inner]"]);
  assert.equal(S().tabs[e.pinned[0].slice(2)].pinnedUrl, "https://a.com");
  assert.equal(Object.keys(S().bookmarks.nodes).length, bookmarks, "no bookmarks");
});

test("Arc imports retain every usable overflow tab in the fifth folder level", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.com" });
  const spaceId = S().windows[w].spaceId;
  let pinned = [];
  for (let depth = 80; depth >= 1; depth--) {
    pinned = [{ type: "folder", title: `Level ${depth}`, children: [link(`level-${depth}`), ...pinned] }];
  }
  const n = await importArcSpace(spaceId, { id: "deep", name: "Deep", profileId: "Default", pinned, tabs: [] });
  assert.equal(n, 80);
  const folders = Object.values(S().pinnedFolders);
  assert.equal(folders.length, 5);
  assert.deepEqual(
    folders.map((f) => folderDepth(S(), f.id)),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    folderTabIds(S(), folders[4].id).map(short),
    Array.from({ length: 76 }, (_, i) => `level-${i + 5}`),
  );
  assert.deepEqual(
    folderTabIds(S(), folders[0].id).map(short),
    Array.from({ length: 80 }, (_, i) => `level-${i + 1}`),
  );
});

test("empty Arc folders keep their parents and destination space even with another space focused", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.com" });
  const focused = S().windows[w].spaceId;
  const destination = S().createSpace({ name: "Imported" });
  const n = await importArcSpace(destination, {
    id: "empty",
    name: "Empty",
    profileId: "Default",
    pinned: [{ type: "folder", title: "Root", children: [{ type: "folder", title: "Child", children: [] }] }],
    tabs: [],
  });
  assert.equal(n, 0);
  const [root, child] = Object.values(S().pinnedFolders);
  assert.equal(root.spaceId, destination);
  assert.equal(child.spaceId, destination);
  assert.equal(child.parentId, root.id);
  assert.deepEqual(sidebarEntries(S(), w, focused).pinned, []);
  assert.deepEqual(sidebarEntries(S(), w, destination).pinned, [`f:${root.id}`]);
  assert.deepEqual(folderEntries(S(), root.id), [`f:${child.id}`]);
});

test("Arc preserves mixed direct tabs, nested folders and empty siblings at every level", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.com" });
  const spaceId = S().windows[w].spaceId;
  const pinned = [
    folder("Empty first", folder("Empty descendant")),
    link("loose"),
    folder("Empty before root"),
    folder(
      "Root",
      folder("Empty before a"),
      link("a"),
      folder("Empty before child"),
      folder(
        "Child",
        link("b"),
        folder("Empty before grandchild"),
        folder(
          "Grandchild",
          link("deep-start"),
          folder("Empty deep"),
          folder("Fourth", link("fourth-start"), folder("Empty fourth"), folder("Fifth", link("fifth-start"), link("fifth-end")), link("fourth-end")),
          link("deep-end"),
        ),
        folder("Empty after grandchild"),
        link("child-tail"),
        folder("Empty child tail"),
      ),
      folder("Empty after child"),
      link("c"),
      folder("Empty root tail"),
    ),
    folder("Empty after root"),
    link("tail"),
    folder("Empty last", folder("Empty last descendant")),
  ];
  assert.equal(await importArcSpace(spaceId, { id: "mixed", name: "Mixed", profileId: "Default", pinned, tabs: [] }), 12);
  const sourceTree = (node) => (node.type === "folder" ? { folder: node.title, children: node.children.map(sourceTree) } : node.title);
  const importedTree = (entry) => {
    const id = entry.slice(2);
    return entry.startsWith("f:") ? { folder: S().pinnedFolders[id].name, children: folderEntries(S(), id).map(importedTree) } : S().tabs[id].title;
  };
  assert.deepEqual(sidebarEntries(S(), w).pinned.map(importedTree), pinned.map(sourceTree));
});
