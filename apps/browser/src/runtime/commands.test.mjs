import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { viewTabIds } from "../store/model.ts";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { browserRead, createBrowserReader, createLocalBrowserReadSource, createClientBrowserReadSource } from "../store/read.ts";
import { createBrowserAuthority } from "./authority.ts";
import { createBrowserClient } from "./client.ts";
import { createLocalBrowserCommands, createClientBrowserCommands, installBrowserCommands, dispatchBrowserCommand } from "./commands.ts";
// The bar's unused restore helper imports the window action module, whose space
// picker and animated pager need native views. Keep its store actions real and
// fail if these visual-only paths are unexpectedly exercised by command tests.
const unavailableView =
  "data:text/javascript," +
  encodeURIComponent(
    'export const pageToSpace = () => { throw new Error("native pager is unavailable in command tests"); }; export const requestCreateSpace = () => { throw new Error("space picker is unavailable in command tests"); };',
  );
const nativeStub = new URL("../test-native-stub.mjs", import.meta.url).href;
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
const { openFromBar, openInBackground, switchFromBar } = await import("../components/omnibox/open.ts");
import { openNewTabPanel } from "../lib/newTab.ts";

const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("readonly browser sources detach data, preserve node identity and expose no reducers", () => {
  const store = createBrowserStore();
  const source = createLocalBrowserReadSource(store);
  const before = source.getState();
  assert.strictEqual(source.getState(), before);
  assert.equal(before.createWindow, undefined);
  assert.throws(() => {
    before.spaceOrder.push("injected");
  }, TypeError);
  const id = store.getState().createWindow();
  const after = source.getState();
  assert.notStrictEqual(after, before);
  assert.strictEqual(after.settings, before.settings);
  assert.equal(before.windows[id], undefined);
  assert.ok(after.windows[id]);
});

test("local product helpers mutate synchronously while returning honest Promise results", async (t) => {
  const store = createBrowserStore();
  const id = store.getState().createWindow({ url: "https://old.example/" });
  const tab = viewTabIds(store.getState(), id)[0];
  const legacy = useBrowser.getState();
  t.after(installBrowserCommands(createLocalBrowserCommands(store)));
  const opening = openFromBar("https://new.example/", tab, "current");
  assert.ok(opening instanceof Promise);
  assert.equal(store.getState().tabs[tab].navigation.url, "https://new.example/");
  assert.equal(await opening, null);
  const panel = openNewTabPanel(id);
  assert.equal(store.getState().windowUi[id].panel.mode, "newTab");
  assert.equal(await panel, null);
  assert.strictEqual(useBrowser.getState(), legacy);
  const count = Object.keys(store.getState().tabs).length;
  await openInBackground("https://background.example/", tab);
  assert.equal(Object.keys(store.getState().tabs).length, count + 1);
  assert.equal(store.getState().windows[id].activeTabIds.default, tab);
});

test("a remote product helper waits for its acknowledged mirror and updates both clients", async (t) => {
  const store = createBrowserStore();
  const id = store.getState().createWindow({ url: "https://original.example/" });
  const tab = viewTabIds(store.getState(), id)[0];
  const authority = createBrowserAuthority({ epoch: "product-epoch", store });
  const pending = [];
  const connect = (clientId) => {
    const commits = new Set();
    const stop = authority.subscribe((commit) => {
      for (const listener of commits) listener(commit);
    });
    const client = createBrowserClient({
      clientId,
      transport: {
        getSnapshot: async () => authority.getSnapshot(),
        async dispatch(request) {
          const reply = await authority.dispatch(request);
          const held = deferred();
          pending.push({ reply, held });
          return held.promise;
        },
        subscribeCommits(listener) {
          commits.add(listener);
          return () => commits.delete(listener);
        },
        subscribeClose() {
          return () => {};
        },
      },
    });
    t.after(() => {
      client.close();
      stop();
    });
    return client;
  };
  t.after(() => authority.close());
  const first = connect("first-window"),
    second = connect("second-window");
  await Promise.all([first.ready, second.ready]);
  const firstRead = createBrowserReader(createClientBrowserReadSource(first));
  const secondRead = createBrowserReader(createClientBrowserReadSource(second));
  let renders = 0;
  t.after(
    firstRead.subscribe(() => {
      renders++;
    }),
  );
  const restore = installBrowserCommands(createClientBrowserCommands(first));
  const restoreRead = browserRead.install(createClientBrowserReadSource(first));
  let restoreSecond = () => {};
  t.after(() => {
    restoreSecond();
    restore();
    restoreRead();
  });
  let done = false;
  const open = openFromBar("https://shared.example/", tab, "newTab").then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false, "publication alone is not command acknowledgement");
  assert.equal(firstRead.getState().windowOrder.length, 1);
  const newTab = store.getState().windows[id].activeTabIds.default;
  assert.notEqual(newTab, tab);
  assert.equal(firstRead.getState().tabs[newTab].url, "https://shared.example/");
  assert.equal(secondRead.getState().tabs[newTab].url, "https://shared.example/");
  assert.ok(renders > 0);
  const firstReply = pending.shift();
  firstReply.held.resolve(firstReply.reply);
  await open;
  assert.equal(done, true);
  assert.equal(browserRead.getState().tabs[newTab].url, "https://shared.example/");
  restore();
  restoreSecond = installBrowserCommands(createClientBrowserCommands(second));
  const switched = switchFromBar(tab, "https://original.example/", newTab, "current");
  await tick();
  const secondReply = pending.shift();
  secondReply.held.resolve(secondReply.reply);
  assert.equal(await switched, null);
  assert.equal(firstRead.getState().windows[id].activeTabIds.default, tab);
  assert.equal(secondRead.getState().windows[id].activeTabIds.default, tab);
});

test("failed remote product commands reject without falling back to local mutations", async (t) => {
  const before = useBrowser.getState();
  t.after(installBrowserCommands({ dispatch: () => Promise.reject(new Error("runtime disconnected")) }));
  await assert.rejects(openFromBar("https://never-local.example/", "missing", "newTab"), /runtime disconnected/);
  await assert.rejects(openNewTabPanel("missing"), /runtime disconnected/);
  assert.strictEqual(useBrowser.getState(), before);
});

test("disposing older read and command installations cannot restore a disposed runtime", async () => {
  const base = createLocalBrowserReadSource(createBrowserStore());
  const older = createLocalBrowserReadSource(createBrowserStore());
  const newer = createLocalBrowserReadSource(createBrowserStore());
  const reader = createBrowserReader(base);
  const removeOlder = reader.install(older);
  const removeNewer = reader.install(newer);
  removeOlder();
  assert.strictEqual(reader.getState(), newer.getState());
  removeNewer();
  assert.strictEqual(reader.getState(), base.getState());
  removeNewer();

  let calls = 0;
  const removeFirst = installBrowserCommands({
    dispatch: async () => {
      throw new Error("disposed runtime");
    },
  });
  const removeSecond = installBrowserCommands({
    dispatch: async () => {
      calls++;
      return null;
    },
  });
  removeFirst();
  await dispatchBrowserCommand({ method: "requestNewTab", windowId: "missing" });
  assert.equal(calls, 1);
  removeSecond();
  // Falls back to the existing local store, never the disposed older port.
  await assert.rejects(dispatchBrowserCommand({ method: "requestNewTab", windowId: "missing" }), { code: "invalid_request" });
});
