import assert from "node:assert/strict";
import { test } from "node:test";
import { viewTabIds } from "../store/model.ts";
import { createBrowserStore } from "../store/browser.ts";
import { createBrowserAuthority } from "./authority.ts";
import { createBrowserCoordinator } from "./coordinator.ts";
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function coordinatorTransport({ manualPublish = false, bootstrap = {} } = {}) {
  const published = [],
    resolutions = [],
    publicationAcks = [],
    calls = [];
  let commandHandler,
    closeHandler,
    disposed = 0,
    ready = 0;
  const transport = {
    bootstrap: { version: 1, role: "coordinator", epoch: "new-epoch", clientId: "coordinator-1", ...bootstrap },
    publish(commit) {
      published.push(commit);
      calls.push(["publish", commit.revision]);
      if (!manualPublish) return Promise.resolve();
      const ack = deferred();
      publicationAcks.push(ack);
      return ack.promise;
    },
    resolve(token, reply) {
      resolutions.push({ token, reply });
      calls.push(["resolve", token]);
      return Promise.resolve();
    },
    announceReady() {
      ready++;
      calls.push(["ready"]);
      return Promise.resolve();
    },
    subscribeCommands(callback) {
      commandHandler = callback;
      return () => {
        commandHandler = null;
      };
    },
    subscribeClose(callback) {
      closeHandler = callback;
      return () => {
        closeHandler = null;
      };
    },
    dispose() {
      disposed++;
      const callback = closeHandler;
      closeHandler = null;
      callback?.(new Error("disposed"));
    },
  };
  return {
    transport,
    published,
    resolutions,
    publicationAcks,
    calls,
    get disposed() {
      return disposed;
    },
    get ready() {
      return ready;
    },
    command(token, command, requestId = 1, clientId = "window-1") {
      commandHandler?.(token, { epoch: "new-epoch", clientId, requestId, command });
    },
    disconnect(error = new Error("coordinator disconnected")) {
      closeHandler?.(error);
    },
  };
}

test("coordinator publishes revision zero before explicit readiness", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport(),
    errors = [];
  const runtime = await createBrowserCoordinator({ store, transport: native.transport, onError: (error) => errors.push(error) });
  assert.deepEqual(native.calls, [["publish", 0]]);
  assert.equal(native.ready, 0);
  store.getState().createWindow();
  await runtime.flushPublications();
  assert.deepEqual(
    native.published.map((commit) => commit.revision),
    [0, 1],
  );
  await Promise.all([runtime.announceReady(), runtime.announceReady()]);
  assert.equal(native.ready, 1);
  assert.deepEqual(native.calls, [["publish", 0], ["publish", 1], ["ready"]]);
  runtime.dispose();
  runtime.dispose();
  assert.equal(native.disposed, 1);
  assert.deepEqual(errors, []);
});

test("commands resolve their native token only after their commit is accepted", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport({ manualPublish: true }),
    errors = [];
  const starting = createBrowserCoordinator({ store, transport: native.transport, onError: (error) => errors.push(error) });
  await tick();
  assert.equal(native.published[0].revision, 0);
  native.command("token-1", { method: "createWindow", options: { url: "https://example.com/" } });
  await tick();
  assert.equal(store.getState().windowOrder.length, 0);
  native.publicationAcks[0].resolve();
  const runtime = await starting;
  await tick();
  assert.equal(native.published[1].revision, 1);
  assert.equal(native.resolutions.length, 0);
  native.publicationAcks[1].resolve();
  await tick();
  const response = native.resolutions[0];
  assert.equal(response.token, "token-1");
  assert.equal(response.reply.epoch, "new-epoch");
  assert.equal(response.reply.revision, 1);
  assert.ok(store.getState().windows[response.reply.value]);
  assert.deepEqual(errors, []);
  runtime.dispose();
});

test("multiple native commands preserve authority order and publication sequence", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport();
  const runtime = await createBrowserCoordinator({ store, transport: native.transport });
  native.command("token-1", { method: "createWindow", options: { url: "https://first.example/" } }, 1);
  native.command("token-2", { method: "createWindow", options: { url: "https://second.example/" } }, 2);
  await tick();
  assert.deepEqual(
    native.published.map((commit) => commit.revision),
    [0, 1, 2],
  );
  assert.deepEqual(
    native.resolutions.map((entry) => entry.token),
    ["token-1", "token-2"],
  );
  const [one, two] = native.resolutions.map((entry) => entry.reply.value);
  assert.deepEqual(store.getState().windowOrder, [one, two]);
  runtime.dispose();
});

test("invalid user commands resolve errors without breaking subsequent commands", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport();
  const runtime = await createBrowserCoordinator({ store, transport: native.transport });
  native.command("bad-token", { method: "hydrate", state: {} }, 1);
  native.command("good-token", { method: "createWindow" }, 2);
  await tick();
  const refused = native.resolutions.find((entry) => entry.token === "bad-token");
  assert.equal(refused.reply.epoch, "new-epoch");
  assert.equal(refused.reply.error.code, "invalid_request");
  assert.ok(native.resolutions.find((entry) => entry.token === "good-token").reply.value);
  assert.deepEqual(
    native.published.map((commit) => commit.revision),
    [0, 1],
  );
  runtime.dispose();
});

test("crash recovery preserves accepted live, navigation, adoption and UI state without hydrate", async () => {
  const previousStore = createBrowserStore(),
    previous = createBrowserAuthority({ epoch: "old-epoch", store: previousStore });
  const windowId = previousStore.getState().createWindow({ url: "https://saved.example/" }),
    tabId = viewTabIds(previousStore.getState(), windowId)[0];
  previousStore.getState().updateTab(tabId, { adoptId: "native-page-7" }, { isLoading: true, progress: 0.7 });
  previousStore.getState().openPanel(windowId, "keep me");
  const recovery = previous.getSnapshot().state,
    store = createBrowserStore();
  let hydrated = 0;
  const createWindow = store.getState().createWindow;
  store.setState({
    hydrate() {
      hydrated++;
      throw new Error("never hydrate recovery");
    },
  });
  const native = coordinatorTransport({ bootstrap: { recoveryState: recovery } });
  const runtime = await createBrowserCoordinator({ store, transport: native.transport });
  assert.equal(hydrated, 0);
  assert.equal(store.getState().createWindow, createWindow);
  assert.equal(store.getState().tabs[tabId].adoptId, "native-page-7");
  assert.deepEqual(store.getState().tabs[tabId].navigation, recovery.tabs[tabId].navigation);
  assert.equal(store.getState().live[tabId].progress, 0.7);
  assert.equal(store.getState().windowUi[windowId].panel.initialText, "keep me");
  assert.equal(native.published[0].epoch, "new-epoch");
  assert.equal(native.published[0].revision, 0);
  assert.notEqual(store.getState().tabs, recovery.tabs);
  assert.ok(!Object.isFrozen(store.getState().tabs[tabId]));
  runtime.dispose();
  previous.close();
});

test("recovery validation fails before mutating the store and closes its pipe", async () => {
  const store = createBrowserStore(),
    original = store.getState(),
    native = coordinatorTransport({ bootstrap: { recoveryState: { tabs: {} } } });
  await assert.rejects(createBrowserCoordinator({ store, transport: native.transport }), { code: "invalid_protocol" });
  assert.equal(store.getState(), original);
  assert.equal(native.disposed, 1);
  assert.equal(native.published.length, 0);
});

test("window connections cannot start a coordinator", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport({ bootstrap: { role: "window", windowId: "window-1" } });
  await assert.rejects(createBrowserCoordinator({ store, transport: native.transport }), /coordinator connection/);
  assert.equal(native.disposed, 1);
  assert.equal(native.published.length, 0);
});

test("publication failure closes the authority and leaves command outcome uncertain", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport({ manualPublish: true }),
    errors = [];
  const starting = createBrowserCoordinator({ store, transport: native.transport, onError: (error) => errors.push(error) });
  await tick();
  native.publicationAcks[0].resolve();
  const runtime = await starting;
  native.command("token", { method: "createWindow" });
  await tick();
  native.publicationAcks[1].reject(new Error("publish refused"));
  await tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /publish refused/);
  assert.equal(native.disposed, 1);
  assert.equal(native.resolutions.length, 0, "an unpublished mutation cannot be reported as committed");
  await assert.rejects(runtime.flushPublications(), /publish refused/);
});

test("disconnect stops publication and never replays a pending command", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport(),
    errors = [];
  const runtime = await createBrowserCoordinator({ store, transport: native.transport, onError: (error) => errors.push(error) });
  native.disconnect();
  store.getState().createWindow();
  await tick();
  assert.equal(native.published.length, 1);
  assert.equal(native.disposed, 1);
  assert.equal(errors.length, 1);
  await assert.rejects(runtime.announceReady(), /disconnected/);
});

test("readiness waits for outstanding publications and is never automatic", async () => {
  const store = createBrowserStore(),
    native = coordinatorTransport({ manualPublish: true });
  const starting = createBrowserCoordinator({ store, transport: native.transport });
  await tick();
  native.publicationAcks[0].resolve();
  const runtime = await starting;
  store.getState().createWindow();
  const ready = runtime.announceReady();
  await tick();
  assert.equal(native.ready, 0);
  native.publicationAcks[1].resolve();
  await ready;
  assert.equal(native.ready, 1);
  runtime.dispose();
});
