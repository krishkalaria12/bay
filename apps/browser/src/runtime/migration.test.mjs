import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { browserRead, createClientBrowserReadSource, installBrowserReadSource } from "../store/read.ts";
import { activeTabId } from "../store/model.ts";
import { docs } from "../test-native-stub.mjs";
import { createNativeWindowReconciler } from "../lib/nativeWindows.ts";
import { createBrowserCoordinator } from "./coordinator.ts";
import { createBrowserClient } from "./client.ts";
import { createClientBrowserCommands, installBrowserCommands } from "./commands.ts";
import { newTab } from "./tabActions.ts";
import { createWindow } from "./windowActions.ts";
import { updateSettings } from "./settingsActions.ts";

const tick = () => new Promise(setImmediate);
const copy = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each endpoint binds its own identity, as the native broker does. Copies keep
 * renderer and coordinator objects isolated even though this test is in-process.
 */
function memoryBroker() {
  const epoch = "migration-epoch";
  const commits = new Map();
  const endpoints = new Map();
  const pending = new Map();
  const requests = [];
  const resolutions = [];
  const held = [];
  let current;
  let commandHandler;
  let closeHandler;
  let nextToken = 0;
  let holdPublications = false;
  let disposed = false;
  function send(clientId, request) {
    const authenticated = { ...copy(request), epoch, clientId };
    const token = `command-${++nextToken}`;
    requests.push({ clientId, request: authenticated });
    return new Promise((resolve, reject) => {
      pending.set(token, { resolve, reject, request: authenticated });
      commandHandler(token, authenticated);
    });
  }
  return {
    requests,
    resolutions,
    held,
    hold() {
      holdPublications = true;
    },
    release() {
      holdPublications = false;
      held.splice(0).forEach((gate) => gate.resolve());
    },
    retryLast() {
      const { clientId, request } = requests.at(-1);
      return send(clientId, request);
    },
    coordinatorTransport: {
      bootstrap: { version: 1, role: "coordinator", epoch, clientId: "authority" },
      async publish(commit) {
        if (holdPublications) {
          const gate = deferred();
          held.push(gate);
          await gate.promise;
        }
        current = copy(commit);
        commits.set(commit.revision, current);
        for (const endpoint of endpoints.values()) for (const listener of endpoint.commits) listener(copy(current));
      },
      async resolve(token, reply) {
        resolutions.push({ token, reply: copy(reply) });
        const sent = pending.get(token);
        assert.ok(sent, "a resolution must belong to an authenticated request");
        pending.delete(token);
        if (reply.error) sent.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        else {
          const commit = commits.get(reply.revision);
          assert.ok(commit, "a command cannot resolve before the broker accepts its publication");
          sent.resolve({ clientId: sent.request.clientId, requestId: sent.request.requestId, value: reply.value, commit: copy(commit) });
        }
      },
      async announceReady() {},
      subscribeCommands(listener) {
        commandHandler = listener;
        return () => {
          commandHandler = null;
        };
      },
      subscribeClose(listener) {
        closeHandler = listener;
        return () => {
          closeHandler = null;
        };
      },
      dispose() {
        disposed = true;
        for (const endpoint of endpoints.values()) for (const listener of endpoint.closures) listener();
      },
    },
    windowTransport(clientId) {
      const endpoint = { commits: new Set(), closures: new Set() };
      endpoints.set(clientId, endpoint);
      return {
        async getSnapshot() {
          return copy(current);
        },
        dispatch(request) {
          if (disposed) return Promise.reject(new Error("broker closed"));
          return send(clientId, request);
        },
        subscribeCommits(listener) {
          endpoint.commits.add(listener);
          return () => endpoint.commits.delete(listener);
        },
        subscribeClose(listener) {
          endpoint.closures.add(listener);
          return () => endpoint.closures.delete(listener);
        },
      };
    },
    disconnect() {
      closeHandler?.(new Error("broker disconnected"));
    },
  };
}

function usingClient(client, run) {
  const restoreCommands = installBrowserCommands(createClientBrowserCommands(client));
  const restoreRead = installBrowserReadSource(createClientBrowserReadSource(client));
  try {
    return run();
  } finally {
    restoreRead();
    restoreCommands();
  }
}
async function start(t, options = {}) {
  const store = createBrowserStore();
  const first = store.getState().createWindow({ url: "first.example" });
  const second = store.getState().createWindow({ url: "second.example" });
  const broker = memoryBroker();
  const coordinator = await createBrowserCoordinator({ store, transport: broker.coordinatorTransport, ...options });
  const clients = ["window-one", "window-two"].map((clientId) => createBrowserClient({ clientId, transport: broker.windowTransport(clientId) }));
  await Promise.all(clients.map((client) => client.ready));
  t.after(() => {
    clients.forEach((client) => client.close());
    coordinator.dispose();
  });
  return { store, first, second, broker, coordinator, clients };
}
function assertConverged(coordinator, clients) {
  for (const client of clients) assert.deepEqual(client.getSnapshot(), coordinator.getSnapshot());
}

test("two mirrors converge across concurrent tab, window and settings actions without mutating the legacy store", async (t) => {
  const legacy = useBrowser.getState();
  const {
    store,
    first,
    second,
    broker,
    coordinator,
    clients: [one, two],
  } = await start(t);
  broker.hold();
  let completed = false;
  const opening = usingClient(one, () => newTab(first, { url: "https://ack.example/", background: true })).then((id) => {
    completed = true;
    assert.ok(one.getSnapshot().state.tabs[id], "the caller has installed its acknowledged state before returning");
    return id;
  });
  await tick();
  assert.equal(completed, false);
  assert.equal(broker.held.length, 1);
  assert.ok(Object.values(store.getState().tabs).some((tab) => tab.url === "https://ack.example/"));
  assert.equal(
    Object.values(one.getSnapshot().state.tabs).some((tab) => tab.url === "https://ack.example/"),
    false,
  );
  assert.equal(broker.resolutions.length, 0);
  assert.equal(useBrowser.getState(), legacy);
  broker.release();
  const opened = await opening;
  const [left, right] = await Promise.all([
    usingClient(one, () => newTab(first, { url: "left.example", background: true })),
    usingClient(two, () => newTab(second, { url: "right.example", background: true })),
  ]);
  assert.notEqual(left, right);
  const [third, fourth] = await Promise.all([
    usingClient(one, () => createWindow({ url: "third.example", background: true })),
    usingClient(two, () => createWindow({ url: "fourth.example", background: true })),
  ]);
  await Promise.all([usingClient(one, () => updateSettings({ appearance: "dark" })), usingClient(two, () => updateSettings({ sidebarWidth: 320 }))]);
  assertConverged(coordinator, [one, two]);
  assert.ok(one.getSnapshot().state.tabs[opened]);
  assert.ok(two.getSnapshot().state.windows[third]);
  assert.ok(one.getSnapshot().state.windows[fourth]);
  assert.equal(one.getSnapshot().state.settings.appearance, "dark");
  assert.equal(two.getSnapshot().state.settings.sidebarWidth, 320);
  usingClient(one, () => {
    assert.equal(browserRead.getState(), one.getSnapshot().state);
    assert.equal("newTab" in browserRead.getState(), false);
  });
  assert.equal(useBrowser.getState(), legacy);
  assert.equal(Object.isFrozen(one.getSnapshot().state.tabs[left]), true);
});

test("duplicate broker requests run a user reducer and owner focus/native reconciliation once across both mirrors", async (t) => {
  const focused = [];
  const {
    store,
    first,
    second,
    broker,
    coordinator,
    clients: [one, two],
  } = await start(t, { effects: { focusWindow: (id) => focused.push(id) } });
  const native = { opened: [], closed: [], released: [], errors: [] };
  const reconciler = createNativeWindowReconciler({
    open: (id) => {
      native.opened.push(id);
    },
    close: (id) => {
      native.closed.push(id);
    },
    setTitle() {},
    focus: (id) => focused.push(id),
    openFailed: (id) => {
      throw new Error(`unexpected failed open ${id}`);
    },
    closed: (id) => native.released.push(id),
    report: (...args) => native.errors.push(args),
  });
  const sync = () => {
    const s = store.getState();
    reconciler.sync(
      s.windowOrder.map((id) => ({ id, title: "Bay", options: {} })),
      s.ui.focusedWindowId,
    );
  };
  sync();
  t.after(store.subscribe(sync));
  await tick();
  assert.deepEqual(native.opened, [first, second]);
  let created = 0;
  const create = store.getState().createWindow;
  store.setState({
    createWindow(options) {
      created++;
      return create(options);
    },
  });
  const opening = one.dispatch({ method: "createWindow", options: { url: "once.example", background: true } });
  await tick();
  const duplicate = await broker.retryLast();
  const id = await opening;
  assert.equal(duplicate.value, id);
  assert.equal(created, 1);
  assert.deepEqual(native.opened, [first, second, id]);
  const show = two.dispatch({ method: "showTab", tabId: activeTabId(store.getState(), first), windowId: first });
  await tick();
  await broker.retryLast();
  await show;
  assert.deepEqual(focused, [first]);
  const closing = one.dispatch({ method: "closeWindow", windowId: id });
  await tick();
  await broker.retryLast();
  await closing;
  assert.deepEqual(native.closed, [id]);
  assert.deepEqual(native.released, [id]);
  assert.deepEqual(native.errors, []);
  assertConverged(coordinator, [one, two]);
});

test("settings from both mirrors persist once at the explicit owner and optional command IDs may be null", async (t) => {
  const legacy = useBrowser.getState();
  const {
    store,
    first,
    coordinator,
    clients: [one, two],
  } = await start(t);
  const writes = [];
  const setDocument = docs.set;
  docs.set = function (name, json) {
    writes.push({ name, json });
    return setDocument.call(this, name, json);
  };
  t.after(() => {
    docs.set = setDocument;
  });
  await Promise.all([
    one.dispatch({ method: "updateSettings", patch: { appearance: "dark" } }),
    two.dispatch({ method: "updateSettings", patch: { sidebarWidth: 333 } }),
  ]);
  await coordinator.flushPersistence();
  assert.equal(writes.filter((entry) => entry.name === "session.json").length, 1);
  const saved = JSON.parse(writes.find((entry) => entry.name === "session.json").json);
  assert.equal(saved.settings.appearance, "dark");
  assert.equal(saved.settings.sidebarWidth, 333);
  assert.equal(useBrowser.getState(), legacy);
  assertConverged(coordinator, [one, two]);
  await coordinator.flushPersistence();
  assert.equal(writes.filter((entry) => entry.name === "session.json").length, 1, "unchanged mirror installation must not write the session again");
  // These optional-result reducers legitimately return undefined when no page
  // or destination can be produced. Their wire replies must normalize to null.
  store.setState({ duplicateTab() {}, moveTabsToWindow() {} });
  const tabId = activeTabId(store.getState(), first);
  assert.equal(await one.dispatch({ method: "duplicateTab", tabId }), null);
  assert.equal(await two.dispatch({ method: "moveTabsToWindow", tabIds: [tabId], windowId: first }), null);
  assert.equal(one.getStatus(), "ready");
  assert.equal(two.getStatus(), "ready");
});

test("a disconnected mirror rejects helper actions without replaying them into the legacy store", async (t) => {
  const errors = [];
  const {
    store,
    first,
    broker,
    clients: [one],
  } = await start(t, { onError: (error) => errors.push(error) });
  const authorityState = store.getState();
  const legacy = useBrowser.getState();
  const sent = broker.requests.length;
  const pending = usingClient(one, () => {
    broker.disconnect();
    return newTab(first, { url: "https://never-replayed.example/" });
  });
  await assert.rejects(pending, { code: "transport_closed" });
  assert.equal(errors.length, 1);
  assert.equal(broker.requests.length, sent);
  assert.equal(store.getState(), authorityState);
  assert.equal(useBrowser.getState(), legacy);
});
