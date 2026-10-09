// An Arc space's pinned tabs and folders land in the Pinned section, not the Essentials or the bookmarks.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { importArcSpace } = await import("./apply.ts");
const { sidebarEntries } = await import("../sidebar/entries.ts");
const { folderTabIds } = await import("../../store/folders.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com\/?$/g, "");
const link = (name, title) => ({ type: "url", url: `https://${name}.com`, title: title ?? name });

test("an Arc space's pinned tabs become pinned rows and its folders pinned folders, in Arc's order", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://home.com" });
  const spaceId = S().windows[w].spaceId;
  const bookmarks = Object.keys(S().bookmarks.nodes).length;
  const n = importArcSpace(spaceId, {
    id: "s",
    name: "Space",
    spaceId: "Default",
    pinned: [
      link("a"),
      { type: "folder", title: "Work", children: [link("b"), { type: "folder", title: "Inner", children: [link("c")] }, { type: "url", url: "chrome://x", title: "x" }] },
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
  assert.deepEqual(folderTabIds(S(), work.id).map(short), ["b", "c"], "a nested folder gives its tabs to the outer one");
  assert.equal(S().tabs[e.pinned[0].slice(2)].pinnedUrl, "https://a.com");
  assert.equal(Object.keys(S().bookmarks.nodes).length, bookmarks, "no bookmarks");
});
