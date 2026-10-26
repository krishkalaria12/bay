import assert from "node:assert/strict";
import { test } from "node:test";
import { sidebarMoveUndoCalls } from "../test-native-stub.mjs";
const { useBrowser } = await import("../store/browser.ts");
const { armSidebarMoveUndo, startSidebarMoveUndoSync } = await import("./folderUndo.ts");
const S = () => useBrowser.getState();

test("sidebar Undo tracks each window and explicitly arms focus only after a user edit", () => {
  S().hydrate({});
  const w = S().createWindow();
  const parent = S().newPinnedFolder(w, { name: "Work" });
  const child = S().newPinnedFolder(w, { name: "Notes" });
  useBrowser.setState({ sidebarUndo: {} });
  sidebarMoveUndoCalls.length = 0;
  const stop = startSidebarMoveUndoSync();
  try {
    armSidebarMoveUndo(w);
    assert.deepEqual(sidebarMoveUndoCalls, [{ windowId: w, available: false, focus: false }]);

    S().movePinnedFolder(child, null, parent);
    assert.deepEqual(sidebarMoveUndoCalls.at(-2), { windowId: w, available: true, focus: false });
    armSidebarMoveUndo(w);
    assert.deepEqual(sidebarMoveUndoCalls.at(-1), { windowId: w, available: true, focus: true });

    assert.equal(S().undoSidebarEdit(w), true);
    assert.deepEqual(sidebarMoveUndoCalls.at(-1), { windowId: w, available: false, focus: false });
    assert.equal(S().pinnedFolders[child].parentId, undefined);
    const calls = sidebarMoveUndoCalls.length;
    armSidebarMoveUndo("closed-window");
    armSidebarMoveUndo(w);
    assert.equal(sidebarMoveUndoCalls.length, calls);
  } finally {
    stop();
  }
});
