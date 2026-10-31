import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../../store/browser.ts";
import { viewTabIds } from "../../store/model.ts";
import { browserRead, createClientBrowserReadSource, createLocalBrowserReadSource } from "../../store/read.ts";
import { createBrowserAuthority } from "../../runtime/authority.ts";
import { createBrowserClient } from "../../runtime/client.ts";
import { createClientBrowserCommands, installBrowserCommands } from "../../runtime/commands.ts";

// Exercise the real action helpers without native pager or space picker views.
const unavailableView =
  "data:text/javascript," +
  encodeURIComponent(
    'export const pageToSpace = () => { throw new Error("unexpected native pager"); }; export const requestCreateSpace = () => { throw new Error("unexpected space picker"); };',
  );
const nativeStub = new URL("../../test-native-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/lib/actions.ts")) {
      if (["../components/layout/spacePager", "../components/spaces/CreateSpace"].includes(specifier)) return { url: unavailableView, shortCircuit: true };
      if (specifier === "@bay/nncore")
        return {
          url: "data:text/javascript," + encodeURIComponent(`export * from ${JSON.stringify(nativeStub)}; export const listExtensions = async () => [];`),
          shortCircuit: true,
        };
    }
    return next(specifier, context);
  },
});
const { openFolder } = await import("./actions.ts");
const { openLittleBay } = await import("../littleBay/actions.ts");
const tick = () => new Promise(setImmediate);

async function remote(t, store) {
  const authority = createBrowserAuthority({ epoch: "workflow-epoch", store });
  const pending = [];
  const client = createBrowserClient({
    clientId: "workflow-window",
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
  return pending;
}

function bookmarkFolder(store) {
  const folder = store.getState().addBookmarkFolder({ spaceId: "default", title: "Three pages" });
  for (const title of ["one", "two", "three"]) store.getState().addBookmark({ spaceId: "default", parentId: folder, title, url: `https://${title}.example/` });
  return folder;
}

test("opening a bookmark folder waits for each remote tab ID and preserves folder order", async (t) => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://original.example/" });
  store.getState().updateSettings({ newTabPosition: "top" });
  const folder = bookmarkFolder(store);
  const legacy = useBrowser.getState();
  const pending = await remote(t, store);
  let done = false;
  const opening = openFolder(folder, windowId).then(() => {
    done = true;
  });
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].command.method, "newTab");
  assert.equal(Object.keys(store.getState().tabs).length, 2);
  assert.equal(done, false);

  const first = viewTabIds(store.getState(), windowId)[0];
  pending.shift().release();
  await tick();
  assert.equal(pending.length, 1, "the next tab starts only after the first ID is acknowledged");
  assert.equal(pending[0].command.options.index, 1);
  assert.equal(pending[0].command.options.background, true);
  pending.shift().release();
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].command.options.index, 2);
  pending.shift().release();
  await opening;

  assert.deepEqual(
    viewTabIds(store.getState(), windowId).map((id) => store.getState().tabs[id].url),
    ["https://one.example/", "https://two.example/", "https://three.example/", "https://original.example/"],
  );
  assert.equal(browserRead.getState().windows[windowId].activeTabIds.default, first);
  assert.strictEqual(useBrowser.getState(), legacy);
});

test("blank Little Bay creates its panel in one command and waits for acknowledgement", async (t) => {
  const store = createBrowserStore();
  const legacy = useBrowser.getState();
  const pending = await remote(t, store);
  let done = false;
  const opening = openLittleBay().then((id) => {
    done = true;
    return id;
  });
  await tick();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].command, { method: "createWindow", options: { small: true }, openPanel: true });
  const windowId = store.getState().windowOrder[0];
  assert.ok(windowId);
  assert.equal(done, false);
  assert.equal(store.getState().windowUi[windowId].panel.open, true);
  assert.equal(browserRead.getState().windowUi[windowId].panel.open, true);
  pending.shift().release();
  assert.equal(await opening, windowId);
  assert.equal(pending.length, 0, "no command targets the new window from its source renderer");
  assert.equal(browserRead.getState().windowUi[windowId].panel.open, true);
  assert.strictEqual(useBrowser.getState(), legacy);
});

test("failed remote folder and Little Bay commands never mutate the legacy singleton", async (t) => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://original.example/" });
  const folder = bookmarkFolder(store);
  const legacy = useBrowser.getState();
  const commands = [];
  t.after(browserRead.install(createLocalBrowserReadSource(store)));
  t.after(
    installBrowserCommands({
      dispatch(command) {
        commands.push(command.method);
        return Promise.reject(new Error("runtime disconnected"));
      },
    }),
  );

  await assert.rejects(openFolder(folder, windowId), /runtime disconnected/);
  await assert.rejects(openLittleBay(), /runtime disconnected/);
  assert.deepEqual(commands, ["newTab", "createWindow"]);
  assert.strictEqual(useBrowser.getState(), legacy);
  assert.equal(Object.keys(store.getState().tabs).length, 1);
});
