import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { sidebarMoveUndoCalls } from "../../test-native-stub.mjs";
import { createBrowserStore, useBrowser } from "../../store/browser.ts";
import { activeTabId } from "../../store/model.ts";
import { browserRead, createClientBrowserReadSource } from "../../store/read.ts";
import { createBrowserAuthority } from "../../runtime/authority.ts";
import { createBrowserClient } from "../../runtime/client.ts";
import { createClientBrowserCommands, installBrowserCommands } from "../../runtime/commands.ts";

// Exercise the real action helpers without native pager or space picker views.
const unavailableView = "data:text/javascript," + encodeURIComponent("export const pageToSpace = () => {}; export const requestCreateSpace = () => {};");
const nativeStub = new URL("../../test-native-stub.mjs", import.meta.url).href;
const nncore = "data:text/javascript," + encodeURIComponent(`export * from ${JSON.stringify(nativeStub)}; export const listExtensions = async () => [];`);
const shell = "data:text/javascript," + encodeURIComponent(`export * from ${JSON.stringify(nativeStub)}; export const showMenu = async () => null;`);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/lib/actions.ts")) {
      if (["../components/layout/spacePager", "../components/spaces/CreateSpace"].includes(specifier)) return { url: unavailableView, shortCircuit: true };
      if (specifier === "@bay/nncore") return { url: nncore, shortCircuit: true };
    }
    if (specifier === "@bay/shell" && context.parentURL?.endsWith("/layout/splitActions.ts")) return { url: shell, shortCircuit: true };
    return next(specifier, context);
  },
});
const { newGroupWithSelection, newPinnedFolderWith } = await import("./actions.ts");
const { sidebarUi } = await import("./state.ts");
const { withFolderMoveUndo } = await import("../../lib/folderUndo.ts");
const { openSplitPane, useToasts } = await import("../layout/splitActions.ts");
const { restoreFromBar } = await import("../omnibox/open.ts");
const { movePinnedFolder } = await import("../../runtime/organizeActions.ts");
const tick = () => new Promise(setImmediate);

// A window's client whose replies wait for `release`, over an authority that owns `store`.
async function remote(t, store) {
  const authority = createBrowserAuthority({ epoch: "sidebar-epoch", store });
  const pending = [];
  const client = createBrowserClient({
    clientId: "sidebar-window",
    transport: {
      getSnapshot: async () => authority.getSnapshot(),
      async dispatch(request) {
        const reply = await authority.dispatch(request);
        return new Promise((resolve) => pending.push({ command: request.command, release: () => resolve(reply) }));
      },
      subscribeCommits: (listener) => authority.subscribe(listener),
      subscribeClose: () => () => {},
    },
  });
  await client.ready;
  const restoreCommands = installBrowserCommands(createClientBrowserCommands(client));
  const restoreRead = browserRead.install(createClientBrowserReadSource(client));
  t.after(() => {
    restoreCommands();
    restoreRead();
    client.close();
    authority.close();
  });
  const release = async () => {
    await tick();
    pending.shift().release();
    await tick();
  };
  return { pending, release };
}

function setup() {
  const store = createBrowserStore();
  const s = () => store.getState();
  const windowId = s().createWindow({ url: "https://a.example/" });
  const a = activeTabId(s(), windowId);
  const b = s().newTab(windowId, { url: "https://b.example/", background: true });
  return { store, s, windowId, a, b };
}

test("new groups and folders rename the acknowledged remote ID without touching the legacy store", async (t) => {
  const { s, store, windowId, a, b } = setup();
  const legacy = useBrowser.getState();
  const { pending, release } = await remote(t, store);

  const grouping = newGroupWithSelection(windowId, [a, b]);
  await tick();
  assert.deepEqual(pending[0].command, { method: "groupTabs", tabIds: [a, b] });
  assert.equal(sidebarUi().renaming, null, "renaming waits for the group's ID");
  await release();
  const groupId = await grouping;
  assert.ok(s().groups[groupId]);
  assert.deepEqual(sidebarUi().renaming, { windowId, kind: "group", id: groupId });

  s().pinRows([b], true);
  const folding = newPinnedFolderWith(windowId, [b]);
  await release();
  const folderId = await folding;
  assert.equal(s().tabs[b].folderId, folderId);
  assert.deepEqual(sidebarUi().renaming, { windowId, kind: "folder", id: folderId });

  assert.equal(await newGroupWithSelection(windowId, [b]), "", "a pinned row alone sends no group command");
  assert.equal(pending.length, 0);
  assert.strictEqual(useBrowser.getState(), legacy);
});

test("folder moves arm Undo only once acknowledged, and only when one was recorded", async (t) => {
  const { s, store, windowId } = setup();
  const parent = s().newPinnedFolder(windowId, { name: "Work" });
  const child = s().newPinnedFolder(windowId, { name: "Notes" });
  const { pending, release } = await remote(t, store);
  sidebarMoveUndoCalls.length = 0;

  withFolderMoveUndo(windowId, () => movePinnedFolder(child, null, parent));
  await tick();
  assert.equal(pending.length, 1);
  assert.deepEqual(sidebarMoveUndoCalls, []);
  await release();
  assert.deepEqual(sidebarMoveUndoCalls, [{ windowId, available: true, focus: true }]);

  // A folder can't move into its own child: nothing moves, so nothing new is undoable.
  withFolderMoveUndo(windowId, () => movePinnedFolder(parent, null, child));
  await release();
  assert.equal(sidebarMoveUndoCalls.length, 1);
});

test("a full split explains itself, and a missing cleaned tab falls back without a command", async (t) => {
  const { s, store, windowId, a, b } = setup();
  const c = s().newTab(windowId, { url: "https://c.example/", background: true });
  s().createSplit([a, b, c]);
  const { pending, release } = await remote(t, store);

  const opening = openSplitPane(windowId, { anchorTabId: a });
  await release();
  assert.equal(await opening, null);
  assert.equal(useToasts.getState().toasts[windowId]?.title, "Cannot Add New Pane");

  assert.equal(await restoreFromBar("missing-entry", a), false);
  assert.equal(pending.length, 0);
});
