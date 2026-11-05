import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntimeTransport } from "./runtimeTransport.ts";
const tick = () => new Promise(setImmediate);
const envelope = (value) => ({ resultJson: JSON.stringify({ value }) });
const stamp = { epoch: "epoch-1", clientId: "client-1" };
const snapshot = (revision = 0) => ({ epoch: stamp.epoch, revision, state: { tabs: {} } });
const request = (requestId = 1) => ({ ...stamp, requestId, command: { method: "activate", tabId: "tab-1" } });
function endpoints(role = "window", overrides = {}) {
  let next = 0,
    closed = 0;
  const handlers = new Map(),
    calls = [];
  const router = (name) => ({
    addListener(callback) {
      const key = ++next;
      handlers.set(key, { name, callback });
      return key;
    },
    removeListener: (key) => handlers.delete(key),
  });
  const bootstrap = { version: 1, role, ...stamp, ...(role === "window" ? { windowId: "window-1" } : {}) };
  const client = {
    onCommit: router("commit"),
    onCommand: router("command"),
    onRuntimeClosed: router("closed"),
    onConnectionError: router("clientError"),
    removeListener: (key) => handlers.delete(key),
    $: { bindNewPipeAndPassRemote: () => "client-pipe", close: () => closed++ },
  };
  const remote = {
    connect: async (pipe) => {
      calls.push(["connect", pipe]);
      return envelope(bootstrap);
    },
    getSnapshot: async () => {
      calls.push(["getSnapshot"]);
      return envelope(snapshot());
    },
    dispatch: async (json) => {
      const input = JSON.parse(json);
      calls.push(["dispatch", input]);
      return envelope({ clientId: input.clientId, requestId: input.requestId, commit: snapshot(1), value: null });
    },
    publish: async (json) => {
      calls.push(["publish", JSON.parse(json)]);
      return envelope(null);
    },
    resolve: async (token, json) => {
      calls.push(["resolve", token, JSON.parse(json)]);
      return envelope(null);
    },
    ready: async () => {
      calls.push(["ready"]);
      return envelope(null);
    },
    onConnectionError: router("remoteError"),
    $: { close: () => closed++ },
    ...overrides,
  };
  return {
    remote,
    client,
    calls,
    handlers,
    bootstrap,
    expectedRole: role,
    closed: () => closed,
    emit(name, ...args) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- Match event-router delivery when callbacks remove or register listeners.
      for (const entry of [...handlers.values()]) if (entry.name === name) entry.callback(...args);
    },
  };
}

test("window Mojo transport binds assigned identity and JSON request/reply envelopes", async () => {
  const native = endpoints(),
    connection = await createAppRuntimeTransport(native);
  assert.deepEqual(connection.bootstrap, native.bootstrap);
  assert.ok(Object.isFrozen(connection.bootstrap));
  assert.deepEqual(await connection.getSnapshot(), snapshot());
  assert.equal((await connection.dispatch(request())).commit.revision, 1);
  assert.deepEqual(native.calls[0], ["connect", "client-pipe"]);
  assert.deepEqual(native.calls[2], ["dispatch", request()]);
  assert.ok(!("publish" in connection) && !("resolve" in connection));
  connection.dispose();
  connection.dispose();
  assert.equal(native.closed(), 2);
  assert.equal(native.handlers.size, 0);
  await assert.rejects(connection.getSnapshot(), { code: "transport_closed" });
});

test("window identity is checked against immutable NativeHost identity", async () => {
  const native = endpoints();
  await assert.rejects(createAppRuntimeTransport({ ...native, expectedWindowId: "another-window" }), { code: "invalid_runtime_message" });
  assert.equal(native.closed(), 2);
  assert.equal(native.handlers.size, 0);
});

for (const [name, alter] of [
  [
    "missing version",
    (value) => {
      delete value.version;
    },
  ],
  [
    "unsupported version",
    (value) => {
      value.version = 2;
    },
  ],
  [
    "wrong role",
    (value) => {
      value.role = "coordinator";
    },
  ],
  [
    "empty epoch",
    (value) => {
      value.epoch = "";
    },
  ],
  [
    "invalid client id",
    (value) => {
      value.clientId = "client with spaces";
    },
  ],
  [
    "missing window",
    (value) => {
      delete value.windowId;
    },
  ],
  [
    "unexpected recovery",
    (value) => {
      value.recoveryState = {};
    },
  ],
])
  test(`bootstrap rejects ${name} and closes both endpoints`, async () => {
    const native = endpoints();
    alter(native.bootstrap);
    await assert.rejects(createAppRuntimeTransport(native), { code: "invalid_runtime_message" });
    assert.equal(native.closed(), 2);
    assert.equal(native.handlers.size, 0);
  });

test("a read-only not_ready bootstrap rejection may be retried with fresh endpoints", async () => {
  const native = endpoints("window", { connect: async () => ({ resultJson: '{"error":{"code":"not_ready","message":"wait"}}' }) });
  await assert.rejects(createAppRuntimeTransport(native), { code: "not_ready" });
  assert.equal(native.closed(), 2);
  const retry = await createAppRuntimeTransport(endpoints());
  retry.dispose();
});

test("events arriving during Connect are retained until the consumer subscribes", async () => {
  let respond;
  const native = endpoints("window", {
    connect: () =>
      new Promise((done) => {
        respond = done;
      }),
  });
  const started = createAppRuntimeTransport(native);
  await tick();
  native.emit("commit", JSON.stringify(snapshot(2)));
  respond(envelope(native.bootstrap));
  const connection = await started,
    seen = [];
  connection.subscribeCommits((commit) => seen.push(commit.revision));
  assert.deepEqual(seen, [2]);
  connection.dispose();
});

test("coordinator operations preserve native token identity and explicit readiness", async () => {
  const native = endpoints("coordinator");
  native.bootstrap.recoveryState = { tabs: { tab: { navigation: { seq: 42 } } } };
  const connection = await createAppRuntimeTransport(native),
    received = [];
  assert.equal(connection.bootstrap.recoveryState.tabs.tab.navigation.seq, 42);
  assert.ok(!("getSnapshot" in connection) && !("dispatch" in connection));
  native.emit("command", "native-token", JSON.stringify(request()));
  const remove = connection.subscribeCommands((token, input) => received.push([token, input]));
  assert.deepEqual(received, [["native-token", request()]]);
  await connection.publish(snapshot());
  await connection.resolve("native-token", { epoch: "epoch-1", revision: 0, value: null });
  assert.equal(
    native.calls.some(([name]) => name === "ready"),
    false,
  );
  await connection.announceReady();
  assert.equal(native.calls.at(-1)[0], "ready");
  await assert.rejects(connection.resolve("native-token", { epoch: "epoch-1", revision: 0, value: null }), { code: "invalid_runtime_message" });
  remove();
  connection.dispose();
});

test("coordinator accepts the origin window stamped by native dispatch", async () => {
  const native = endpoints("coordinator");
  const connection = await createAppRuntimeTransport(native);
  const received = [];
  connection.subscribeCommands((token, input) => received.push([token, input]));
  const forwarded = { ...request(), originWindowId: "window-1" };
  native.emit("command", "native-token", JSON.stringify(forwarded));
  assert.deepEqual(received, [["native-token", forwarded]]);
  await connection.resolve("native-token", { epoch: stamp.epoch, revision: 1, value: null });
  assert.equal(native.closed(), 0);
  connection.dispose();
});

for (const originWindowId of ["", "window with spaces", "x".repeat(129), 1, null])
  test(`coordinator rejects invalid native origin window ${JSON.stringify(originWindowId)}`, async () => {
    const native = endpoints("coordinator");
    const connection = await createAppRuntimeTransport(native);
    let failure;
    connection.subscribeClose((error) => (failure = error));
    native.emit("command", "native-token", JSON.stringify({ ...request(), originWindowId }));
    assert.equal(failure?.code, "invalid_runtime_message");
    assert.equal(native.closed(), 2);
    assert.equal(native.handlers.size, 0);
  });

test("window dispatch cannot supply native origin window metadata", async () => {
  const native = endpoints();
  const connection = await createAppRuntimeTransport(native);
  await assert.rejects(connection.dispatch({ ...request(), originWindowId: "another-window" }), { code: "invalid_runtime_message" });
  assert.deepEqual(native.calls, [["connect", "client-pipe"]]);
  connection.dispose();
});

test("coordinator command failures use native error envelopes", async () => {
  const native = endpoints("coordinator"),
    connection = await createAppRuntimeTransport(native);
  native.emit("command", "native-token", JSON.stringify(request()));
  connection.subscribeCommands(() => {});
  await connection.resolve("native-token", { epoch: "epoch-1", error: { code: "invalid_request", message: "refused" } });
  assert.deepEqual(native.calls.at(-1), ["resolve", "native-token", { epoch: "epoch-1", error: { code: "invalid_request", message: "refused" } }]);
  connection.dispose();
});

test("forged client identifiers are rejected before dispatching native mutations", async () => {
  const native = endpoints(),
    connection = await createAppRuntimeTransport(native);
  await assert.rejects(connection.dispatch({ ...request(), clientId: "forged" }), { code: "invalid_runtime_message" });
  await assert.rejects(connection.dispatch({ ...request(), epoch: "old" }), { code: "stale_epoch" });
  assert.equal(native.calls.length, 1);
  connection.dispose();
});

test("both Mojo connection error routers close pending calls and subscriptions", async () => {
  for (const event of ["remoteError", "clientError"]) {
    const native = endpoints("window", { getSnapshot: () => new Promise(() => {}) }),
      connection = await createAppRuntimeTransport(native);
    const pending = connection.getSnapshot(),
      rejected = assert.rejects(pending, { code: "transport_closed" });
    native.emit(event);
    await rejected;
    assert.equal(native.handlers.size, 0);
    assert.equal(native.closed(), 2);
  }
});

test("native runtime close rejects uncertain operations and retains its reason", async () => {
  const native = endpoints("window", { dispatch: () => new Promise(() => {}) }),
    connection = await createAppRuntimeTransport(native),
    reasons = [];
  connection.subscribeClose((error) => reasons.push(error.code));
  const pending = connection.dispatch(request()),
    rejected = assert.rejects(pending, { code: "coordinator_crashed" });
  native.emit("closed", "coordinator_crashed");
  await rejected;
  assert.deepEqual(reasons, ["coordinator_crashed"]);
  assert.equal(native.handlers.size, 0);
});

test("a malformed event closes the pipe instead of granting the opposite role", async () => {
  const native = endpoints(),
    connection = await createAppRuntimeTransport(native),
    reasons = [];
  connection.subscribeClose((error) => reasons.push(error.code));
  native.emit("command", "token", JSON.stringify(request()));
  assert.deepEqual(reasons, ["invalid_runtime_message"]);
  assert.equal(native.closed(), 2);
});

test("epoch-changing commits require a fresh authenticated connection", async () => {
  const native = endpoints(),
    connection = await createAppRuntimeTransport(native),
    reasons = [];
  connection.subscribeClose((error) => reasons.push(error.code));
  native.emit("commit", JSON.stringify({ ...snapshot(), epoch: "next-epoch" }));
  assert.deepEqual(reasons, ["stale_epoch"]);
});

test("unresponsive Mojo calls time out and close both endpoints", async () => {
  const native = endpoints("window", { connect: () => new Promise(() => {}) });
  await assert.rejects(createAppRuntimeTransport({ ...native, bootstrapTimeoutMs: 5 }), { code: "runtime_timeout" });
  assert.equal(native.closed(), 2);
  assert.equal(native.handlers.size, 0);
});

test("domain rejections remain distinct from protocol corruption", async () => {
  const native = endpoints("window", { getSnapshot: async () => ({ resultJson: '{"error":{"code":"not_ready","message":"wait"}}' }) });
  const connection = await createAppRuntimeTransport(native);
  await assert.rejects(connection.getSnapshot(), { code: "not_ready" });
  assert.equal(native.closed(), 0);
  connection.dispose();
  const malformed = endpoints("window", { getSnapshot: async () => ({ resultJson: "invalid" }) }),
    broken = await createAppRuntimeTransport(malformed);
  await assert.rejects(broken.getSnapshot(), { code: "invalid_result" });
  assert.equal(malformed.closed(), 2);
});

test("duplicate commit subscriptions remove independently", async () => {
  const native = endpoints(),
    connection = await createAppRuntimeTransport(native);
  let count = 0;
  const listener = () => count++;
  const first = connection.subscribeCommits(listener),
    second = connection.subscribeCommits(listener);
  native.emit("commit", JSON.stringify(snapshot(1)));
  assert.equal(count, 2);
  first();
  native.emit("commit", JSON.stringify(snapshot(2)));
  assert.equal(count, 3);
  second();
  connection.dispose();
});

test("the native Connect version-one payload is accepted without changing NativeHost contract versions", async () => {
  // RuntimeConnection::Connect in app_runtime.cc emits this independent schema.
  const bootstrap = {
    version: 1,
    role: "window",
    epoch: "c373a021-5512-4777-a9a5-44d564846caf",
    clientId: "e182fdce-7444-4c99-bc1b-259f36780b6c",
    windowId: "window-42",
  };
  const native = endpoints("window", { connect: async () => envelope(bootstrap) });
  const connection = await createAppRuntimeTransport({ ...native, expectedWindowId: "window-42" });
  assert.deepEqual(connection.bootstrap, bootstrap);
  assert.equal(connection.bootstrap.version, 1);
  connection.dispose();
});
