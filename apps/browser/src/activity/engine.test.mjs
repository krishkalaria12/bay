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
    return specifier === "@bay/desktop" ? { url: `data:text/javascript,${encodeURIComponent(shell)}`, shortCircuit: true } : next(specifier, context);
  },
});

const { createBrowserStore, useBrowser } = await import("../store/browserStore.ts");
const { refreshFolder, startLiveEngine, bindLiveBrowser } = await import("./activityEngine.ts");
const { createFolder, live, setLive } = await import("./activityStore.ts");
const { SOURCES } = await import("./sources.ts");
const { COMPLETION_MS } = await import("./constants.ts");
const tick = () => new Promise(setImmediate);

// The service is the desktop runtime's: its watchers and its grid are in place once its fiber has run.
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

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
  const stops = [];
  // The coordinator binds the store it owns, so the folder asks work on that authority.
  const unbind = bindLiveBrowser(browser);
  context.mock.method(SOURCES.github, "fetch", async () => []);
  context.mock.method(SOURCES.github, "resolveGone", async () => ({}));
  context.after(async () => {
    for (const stop of stops.reverse()) stop();
    await settle();
    unbind();
    context.mock.timers.reset();
  });

  return {
    browser,
    folderId,
    start: async () => {
      const stop = startLiveEngine(browser);

      stops.push(stop);
      await settle();

      return stop;
    },
  };
}

test("live disposal removes timers and watchers and uses the coordinator browser", async (context) => {
  const { browser, folderId, start } = setup(context);
  const tab = browser.getState().newTab(browser.getState().createWindow(), { url: "example.com" });
  browser.getState().updateTab(tab, { liveItem: { folderId: "missing", itemId: "orphan" } });
  const stop = await start();
  assert.equal(browser.getState().tabs[tab].liveItem, undefined);
  assert.equal(startLiveEngine(browser), stop);
  assert.equal(listeners.size, 1);
  const fetch = SOURCES.github.fetch;
  stop();
  stop();
  await settle();
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
  const { folderId, start } = setup(context);

  const old = deferred(),
    current = deferred();

  SOURCES.github.fetch.mock.mockImplementation(() => old.promise);
  const stop = await start();
  const previous = refreshFolder(folderId);
  stop();
  SOURCES.github.fetch.mock.mockImplementation(() => current.promise);
  const stopCurrent = await start();
  const pending = refreshFolder(folderId);
  old.resolve([item("old")]);
  await previous;
  // A second ask joins the read that is running instead of asking the source again, and the stopped read's
  // answer never lands.
  const fetches = SOURCES.github.fetch.mock.callCount();
  const joined = refreshFolder(folderId);
  assert.equal(SOURCES.github.fetch.mock.callCount(), fetches);
  assert.equal(live().items[folderId], undefined);
  current.resolve([item("current")]);
  await pending;
  await joined;
  assert.equal(live().items[folderId][0].id, "current");
  // The restarted engine stops too, and an explicit refresh still works without it.
  stopCurrent();
  await settle();
  SOURCES.github.fetch.mock.mockImplementation(async () => [item("manual")]);
  await refreshFolder(folderId);
  assert.equal(live().items[folderId][0].id, "manual");
});

test("live disposal cancels pending completion and nudge timers", async (context) => {
  const { browser, folderId, start } = setup(context);
  const stop = await start();
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
  await settle();
  const before = live();
  const fetches = SOURCES.github.fetch.mock.callCount();
  context.mock.timers.tick(60_000);
  await tick();
  assert.equal(live(), before);
  assert.equal(SOURCES.github.fetch.mock.callCount(), fetches);
  const stopCurrent = await start();
  context.mock.timers.tick(COMPLETION_MS);
  assert.deepEqual(live().completing[folderId], []);
  stopCurrent();
});

test("a resolveGone result after disposal does not publish a completion", async (context) => {
  const { folderId, start } = setup(context);
  const stop = await start();
  SOURCES.github.fetch.mock.mockImplementation(async () => [item("gone")]);
  await refreshFolder(folderId);
  SOURCES.github.fetch.mock.mockImplementation(async () => []);
  const gone = deferred();
  SOURCES.github.resolveGone.mock.mockImplementation(() => gone.promise);
  const pending = refreshFolder(folderId);
  await tick();
  stop();
  await settle();
  const before = live();
  gone.resolve({ gone: "merged" });
  await pending;
  assert.equal(live(), before);
});

for (const failure of ["native registration", "later subscription"]) {
  test(`live startup unwinds ${failure} failure and can restart`, async (context) => {
    const { browser, folderId, start } = setup(context);
    const error = new Error("registration failed");
    const subscribe = browser.subscribe;
    let subscriptions = 0;

    const browserSubscribe = context.mock.method(browser, "subscribe", (...args) => {
      subscriptions++;

      if (failure === "later subscription" && subscriptions === 2) throw error;

      return subscribe(...args);
    });

    const reported = context.mock.method(console, "error", () => {});

    if (failure === "native registration") globalThis.liveEngineWindowListenerError = error;

    try {
      startLiveEngine(browser);
      await settle();
    } finally {
      globalThis.liveEngineWindowListenerError = undefined;
      browserSubscribe.mock.restore();
    }

    assert.equal(listeners.size, 0);
    assert.ok(reported.mock.callCount() > 0, "the failure is reported");
    context.mock.timers.tick(60_000);
    await tick();
    assert.equal(SOURCES.github.fetch.mock.callCount(), 0);
    browser.setState({ spaces: {} });
    assert.ok(live().folders[folderId], "the failed start detached its browser subscription");
    const stop = await start();
    assert.equal(listeners.size, 1);
    await refreshFolder(folderId);
    assert.equal(SOURCES.github.fetch.mock.callCount(), 1);
    stop();
  });
}
