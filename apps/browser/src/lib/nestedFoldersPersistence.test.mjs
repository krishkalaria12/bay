import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browser.ts");
const { flushPersistence, loadSession, startPersistence } = await import("./persist.ts");
const { folderTabIds } = await import("../store/folders.ts");
const S = () => useBrowser.getState();

test("version-two sessions persist nesting and empty sibling positions without saving undo history", () => {
  stub.docs.clear();
  const stop = startPersistence();
  try {
    const w = S().createWindow({ url: "https://saved.example" });
    const tab = S().windows[w].activeTabIds[S().windows[w].spaceId];
    const root = S().newPinnedFolder(w, { name: "Root" });
    const child = S().newPinnedFolder(w, { name: "Child", parentId: root, tabIds: [tab] });
    const empty = S().newPinnedFolder(w, { name: "Empty", parentId: root, beforeId: child });
    S().movePinnedFolder(child, null, null);
    assert.equal(S().undoPinnedFolderMove(), true);
    flushPersistence();
    const saved = JSON.parse(stub.docs.get("session.json"));
    assert.equal(saved.version, 2);
    assert.equal(saved.folderMoveUndo, undefined);
    assert.equal(saved.pinnedFolders.find((f) => f.id === child).parentId, root);
    assert.equal(saved.pinnedFolders.find((f) => f.id === empty).beforeId, child);
    S().hydrate(loadSession());
    assert.equal(S().pinnedFolders[child].parentId, root);
    assert.equal(S().pinnedFolders[empty].beforeId, child);
    assert.deepEqual(folderTabIds(S(), root), [tab]);
    assert.deepEqual(S().folderMoveUndo, []);
    // An existing flat installation continues to load without changing the session version.
    saved.pinnedFolders = saved.pinnedFolders.map(({ parentId: _parent, beforeId: _before, ...f }) => f);
    stub.docs.set("session.json", JSON.stringify(saved));
    S().hydrate(loadSession());
    assert.equal(S().pinnedFolders[child].parentId, undefined);
    assert.deepEqual(folderTabIds(S(), child), [tab]);
  } finally {
    flushPersistence();
    stop();
  }
});
