import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const listeners = new Set();
globalThis.liveEngineWindowListeners = listeners;
const stub = new URL("../test-native-stub.mjs", import.meta.url).href;
const shell = `export * from ${JSON.stringify(stub)};
export const onWindowEvent = (listener) => {
  if (globalThis.liveEngineWindowListenerError) throw globalThis.liveEngineWindowListenerError;
  const listeners = globalThis.liveEngineWindowListeners;
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
};`;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@bay/shell" ? { url: `data:text/javascript,${encodeURIComponent(shell)}`, shortCircuit: true } : next(specifier, context);
  },
});
const { createBrowserStore, useBrowser } = await import("../store/browser.ts");
const { refreshFolder, startLiveEngine } = await import("./engine.ts");
const { createFolder, live, setLive } = await import("./store.ts");
const { SOURCES } = await import("./sources.ts");
const { COMPLETION_MS } = await import("./constants.ts");
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const item = (id) => ({ id, source: "github", title: id, url: `https://example.com/${id}`, subtitle: "", icon: null, updatedAt: 1 });

function setup(context) {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  setLive({ folders: {}, folderOrder: [], items: {}, status: {}, completing: {}, unread: {}, known: {}, completed: {} });
  const browser = createBrowserStore();
  browser.getState().hydrate({});
  const spaceId = browser.getState().spaceOrder[0];
  const folderId = createFolder(spaceId, "pullRequests", ["github"]);
  context.mock.method(SOURCES.github, "fetch", async () => []);
  context.mock.method(SOURCES.github, "resolveGone", async () => ({}));
  context.after(() => {
    startLiveEngine(browser)();
    context.mock.timers.reset();
  });
  return { browser, folderId };
}

test("live disposal removes timers and watchers and uses the coordinator browser", async (context) => {
  const { browser, folderId } = setup(context);
  const tab = browser.getState().newTab(browser.getState().createWindow(), { url: "example.com" });
  browser.getState().updateTab(tab, { liveItem: { folderId: "missing", itemId: "orphan" } });
  const stop = startLiveEngine(browser);
  assert.equal(browser.getState().tabs[tab].liveItem, undefined);
  assert.equal(startLiveEngine(browser), stop);
  assert.equal(listeners.size, 1);
  const fetch = SOURCES.github.fetch;
  stop();
  stop();
  assert.equal(listeners.size, 0);
  browser.getState().updateTab(tab, { liveItem: { folderId, itemId: "kept" } });
  setLive({ folders: {}, folderOrder: [] });
  assert.ok(browser.getState().tabs[tab].liveItem);
  context.mock.timers.tick(60_000);
  await tick();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(
    Object.values(useBrowser.getState().tabs).some((t) => t.id === tab),
    false,
  );
});

test("live results after disposal cannot overwrite a restarted fetch or clear its inflight entry", async (context) => {
  const { browser, folderId } = setup(context);
  const old = deferred(),
    current = deferred();
  SOURCES.github.fetch.mock.mockImplementation(() => old.promise);
  const stop = startLiveEngine(browser);
  const previous = refreshFolder(folderId);
  stop();
  SOURCES.github.fetch.mock.mockImplementation(() => current.promise);
  const stopCurrent = startLiveEngine(browser);
  const pending = refreshFolder(folderId);
  old.resolve([item("old")]);
  await previous;
  assert.equal(refreshFolder(folderId), pending);
  assert.equal(live().items[folderId], undefined);
  current.resolve([item("current")]);
  await pending;
  assert.equal(live().items[folderId][0].id, "current");
  stopCurrent();
  SOURCES.github.fetch.mock.mockImplementation(async () => [item("manual")]);
  await refreshFolder(folderId);
  assert.equal(live().items[folderId][0].id, "manual");
});

test("live disposal cancels pending completion and nudge timers", async (context) => {
  const { browser, folderId } = setup(context);
  const stop = startLiveEngine(browser);
  SOURCES.github.fetch.mock.mockImplementation(async () => [item("gone")]);
  await refreshFolder(folderId);
  SOURCES.github.fetch.mock.mockImplementation(async () => []);
  SOURCES.github.resolveGone.mock.mockImplementation(async () => ({ gone: "merged" }));
  await refreshFolder(folderId);
  assert.deepEqual(live().completing[folderId], ["gone"]);
  const windowId = browser.getState().createWindow();
  const tab = browser.getState().newTab(windowId, { url: "example.com" });
  browser.getState().updateTab(tab, { liveItem: { folderId, itemId: "gone" } });
  browser.getState().newTab(windowId, { url: "other.com" });
  stop();
  const before = live();
  const fetches = SOURCES.github.fetch.mock.callCount();
  context.mock.timers.tick(60_000);
  await tick();
  assert.equal(live(), before);
  assert.equal(SOURCES.github.fetch.mock.callCount(), fetches);
  const stopCurrent = startLiveEngine(browser);
  context.mock.timers.tick(COMPLETION_MS);
  assert.deepEqual(live().completing[folderId], []);
  stopCurrent();
});

test("a resolveGone result after disposal does not publish a completion", async (context) => {
  const { browser, folderId } = setup(context);
  const stop = startLiveEngine(browser);
  SOURCES.github.fetch.mock.mockImplementation(async () => [item("gone")]);
  await refreshFolder(folderId);
  SOURCES.github.fetch.mock.mockImplementation(async () => []);
  const gone = deferred();
  SOURCES.github.resolveGone.mock.mockImplementation(() => gone.promise);
  const pending = refreshFolder(folderId);
  await tick();
  stop();
  const before = live();
  gone.resolve({ gone: "merged" });
  await pending;
  assert.equal(live(), before);
});

for (const failure of ["native registration", "later subscription"]) {
  test(`live startup unwinds ${failure} failure and can restart`, async (context) => {
    const { browser, folderId } = setup(context);
    const error = new Error("registration failed");
    const subscribe = browser.subscribe;
    let subscriptions = 0;
    const browserSubscribe = context.mock.method(browser, "subscribe", (...args) => {
      subscriptions++;
      if (failure === "later subscription" && subscriptions === 2) throw error;
      return subscribe(...args);
    });
    if (failure === "native registration") globalThis.liveEngineWindowListenerError = error;
    try {
      assert.throws(
        () => startLiveEngine(browser),
        (caught) => caught === error,
      );
    } finally {
      globalThis.liveEngineWindowListenerError = undefined;
      browserSubscribe.mock.restore();
    }
    assert.equal(listeners.size, 0);
    context.mock.timers.tick(60_000);
    await tick();
    assert.equal(SOURCES.github.fetch.mock.callCount(), 0);
    browser.setState({ spaces: {} });
    assert.ok(live().folders[folderId], "the failed start detached its browser subscription");
    const stop = startLiveEngine(browser);
    assert.equal(listeners.size, 1);
    await refreshFolder(folderId);
    assert.equal(SOURCES.github.fetch.mock.callCount(), 1);
    stop();
  });
}
