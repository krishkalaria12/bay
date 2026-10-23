import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindNativeModule,
  decodeNativeResult,
  getNativeHostInfo,
  installNativeTransport,
  invokeNative,
  readNativeSnapshot,
  validateNativeHostInfo,
} from "./nativeBridge.ts";
import { nativeDocumentSave, nativeDocumentWrite, nativeRandomUUID, nativeSnapshot } from "./native.web.ts";
import { nativeContracts } from "./nativeContracts.ts";

const hostInfo = (overrides) => ({
  contractVersion: 2,
  platform: "windows",
  modules: ["BayShell", "BayApp", "BayWebView"],
  views: [],
  constants: { BayApp: { apiVersion: 8 } },
  ...overrides,
});
const transport = (overrides) => ({ getHostInfo: () => hostInfo(), invoke: async () => '{"value":null}', subscribe: () => ({ remove() {} }), ...overrides });

test("optional modules stay absent, desktop identity and contract versions are validated", () => {
  assert.equal(bindNativeModule(transport(), "BayCalendar"), null);
  assert.throws(() => bindNativeModule(transport({ getHostInfo: () => hostInfo({ contractVersion: 1 }) }), "BayCalendar"), { code: "contract_mismatch" });
  for (const invalid of [
    hostInfo({ platform: "android" }),
    hostInfo({ modules: ["BayApp", "BayApp"] }),
    hostInfo({ constants: null }),
    hostInfo({ snapshots: { BayApp: null } }),
  ])
    assert.throws(() => validateNativeHostInfo(invalid));
});
test("every wire method is asynchronous, including former synchronous facades", async () => {
  const calls = [];
  const shell = bindNativeModule(
    transport({
      invoke: async (...args) => {
        calls.push(args);
        return '{"value":"contents"}';
      },
    }),
    "BayShell",
  );
  assert.ok(shell.readDocument("settings.json") instanceof Promise);
  assert.equal(await shell.readDocument("settings.json"), "contents");
  assert.deepEqual(calls[0], ["BayShell", "readDocument", '["settings.json"]']);
  assert.equal(shell.then, undefined);
  assert.equal(shell.unknownMethod, undefined);
  assert.equal(shell.windowIds, shell.windowIds);
  await assert.rejects(shell.openWindow(), { code: "invalid_arguments" });
  for (const module of Object.values(nativeContracts.modules)) for (const method of Object.values(module.methods)) assert.equal(method.async, true);
  assert.equal(nativeContracts.version, 2);
});
test("native constants refresh from host snapshots and optional methods require advertisement", () => {
  let info = hostInfo();
  const native = transport({ getHostInfo: () => info });
  const app = bindNativeModule(native, "BayApp"),
    shell = bindNativeModule(native, "BayShell");
  assert.equal(app.apiVersion, 8);
  info = hostInfo({ constants: { BayApp: { apiVersion: 9 } }, optionalMethods: ["BayShell.windowFrame"] });
  assert.equal(app.apiVersion, 9);
  assert.equal(typeof shell.windowFrame, "function");
  info = hostInfo();
  assert.equal(shell.windowFrame, undefined);
});
test("Linux window button layout uses current snapshots and the advertised optional query", async (t) => {
  let layout = { left: ["close"], right: ["minimize", "maximize"] };
  let info = hostInfo({
    platform: "linux",
    optionalMethods: ["BayShell.windowButtonLayout"],
    snapshots: { BayShell: { windowButtonLayout: layout } },
  });
  let event;
  let removed = false;
  const calls = [];
  const native = transport({
    getHostInfo: () => info,
    invoke: async (...args) => {
      calls.push(args);
      return JSON.stringify({ value: layout });
    },
    subscribe: (module, name, listener) => {
      assert.equal(module, "BayShell");
      assert.equal(name, "onAppEvent");
      event = listener;
      return { remove: () => (removed = true) };
    },
  });
  const connection = installNativeTransport(native);
  t.after(() => connection.remove());
  const shell = bindNativeModule(native, "BayShell");
  const read = () =>
    nativeSnapshot("BayShell", "windowButtonLayout", [], () => {
      throw new Error("Snapshot read must not invoke native code");
    });
  assert.deepEqual(read(), layout);
  assert.deepEqual(calls, []);
  const received = [];
  const subscription = shell.addListener("onAppEvent", (payload) => received.push(payload));
  layout = { left: ["close", "maximize", "minimize"], right: [] };
  info = { ...info, snapshots: { BayShell: { windowButtonLayout: layout } } };
  event({ type: "windowButtonLayout", layout });
  assert.deepEqual(received, [{ type: "windowButtonLayout", layout }]);
  assert.deepEqual(read(), layout);
  assert.deepEqual(calls, []);
  assert.deepEqual(await shell.windowButtonLayout(), layout);
  assert.deepEqual(calls, [["BayShell", "windowButtonLayout", "[]"]]);
  info = { ...info, optionalMethods: [] };
  assert.equal(shell.windowButtonLayout, undefined);
  subscription.remove();
  assert.equal(removed, true);
});
test("envelopes distinguish native errors from engine domain Result values", async () => {
  assert.deepEqual(decodeNativeResult('{"value":{"error":"not found"}}'), { error: "not found" });
  assert.throws(() => decodeNativeResult('{"error":{"code":"denied","message":"Access denied"}}'), { code: "denied", message: "Access denied" });
  for (const value of ["{broken", "null", "[]", "{}", '{"value":null,"error":{}}', '{"error":"bad"}'])
    assert.throws(() => decodeNativeResult(value), { code: "invalid_result" });
  const failed = bindNativeModule(transport({ invoke: async () => '{"error":{"code":"cancelled","message":"Cancelled"}}' }), "BayShell");
  await assert.rejects(failed.windowIds(), { code: "cancelled" });
});
test("native subscriptions validate events and preserve module namespace and removal", () => {
  const calls = [],
    listener = () => {},
    subscription = {
      remove() {
        calls.push("removed");
      },
    };
  const shell = bindNativeModule(
    transport({
      subscribe: (module, event, callback) => {
        calls.push([module, event, callback]);
        return subscription;
      },
    }),
    "BayShell",
  );
  assert.equal(shell.addListener("onCommand", listener), subscription);
  subscription.remove();
  assert.deepEqual(calls, [["BayShell", "onCommand", listener], "removed"]);
  assert.throws(() => shell.addListener("onInvalid", listener), { code: "unknown_event" });
});
test("snapshot facades perform no IPC, missing required state fails, disposal is idempotent", async () => {
  let invoked = 0,
    disposed = 0;
  const installed = installNativeTransport(
    transport({
      getHostInfo: () =>
        hostInfo({
          snapshots: {
            BayApp: { systemInfo: { appName: "Bay" }, environment: { BAY_BACKGROUND: "1" } },
            BayShell: { documents: { "state.json": "saved" } },
            BaySystem: { files: { "C:/test": true }, downloadsFolder: "C:/Downloads" },
          },
        }),
      invoke: async () => {
        invoked++;
        return '{"value":true}';
      },
      dispose: () => disposed++,
    }),
  );
  try {
    const forbiddenFallback = () => {
      throw new Error("Synchronous native fallback called");
    };
    assert.equal(getNativeHostInfo().platform, "windows");
    assert.equal(readNativeSnapshot("BaySystem", "downloadsFolder"), "C:/Downloads");
    assert.deepEqual(nativeSnapshot("BayApp", "systemInfo", [], forbiddenFallback), { appName: "Bay" });
    assert.equal(nativeSnapshot("BayShell", "readDocument", ["state.json"], forbiddenFallback), "saved");
    assert.equal(nativeSnapshot("BayShell", "readDocument", ["missing"], forbiddenFallback), null);
    assert.equal(nativeSnapshot("BayApp", "launchEnvironment", ["absent"], forbiddenFallback), null);
    assert.throws(() => nativeSnapshot("BaySystem", "fileExists", ["C:/test"], forbiddenFallback), { code: "snapshot_unavailable" });
    assert.throws(() => nativeSnapshot("BaySync", "deviceName", [], forbiddenFallback), { code: "snapshot_unavailable" });
    assert.equal(invoked, 0);
    assert.equal(await invokeNative("BayShell", "copyText", ["copied"]), true);
    assert.throws(() => installNativeTransport(transport()), { code: "already_initialized" });
  } finally {
    installed.remove();
    installed.remove();
  }
  assert.equal(disposed, 1);
  assert.throws(() => getNativeHostInfo(), { code: "not_initialized" });
});

test("document snapshots read optimistic writes and native writes preserve per-document order", async () => {
  const calls = [],
    resolvers = [];
  const native = transport({
    getHostInfo: () => hostInfo({ snapshots: { BayShell: { documents: { "state.json": "old" } } } }),
    invoke: (...args) => {
      calls.push(args);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  const installed = installNativeTransport(native);
  const read = () =>
    nativeSnapshot("BayShell", "readDocument", ["state.json"], () => {
      throw new Error("native fallback");
    });
  try {
    nativeDocumentWrite("state.json", "first", () => {});
    nativeDocumentWrite("state.json", "second", () => {});
    assert.equal(read(), "second");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["BayShell", "writeDocument", '["state.json","first"]']]);
    resolvers.shift()('{"value":null}');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.equal(read(), "second");
    resolvers.shift()('{"value":null}');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(read(), "second");
    nativeDocumentWrite("state.json", null, () => {});
    assert.equal(read(), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls[2], ["BayShell", "removeDocument", '["state.json"]']);
    resolvers.shift()('{"value":null}');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    installed.remove();
  }
});

test("acknowledged saves follow queued writes, report failure and allow retry", async () => {
  const calls = [],
    replies = [];
  const installed = installNativeTransport(
    transport({
      getHostInfo: () => hostInfo({ snapshots: { BayShell: { documents: { "state.json": "old" } } } }),
      invoke: (...args) => {
        calls.push(args);
        return new Promise((resolve) => replies.push(resolve));
      },
    }),
  );
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const read = () => nativeSnapshot("BayShell", "readDocument", ["state.json"], () => null);
  try {
    nativeDocumentWrite("state.json", "first", () => {});
    let acknowledged = false;
    const saving = nativeDocumentSave("state.json", "final", async () => {}).then(() => {
      acknowledged = true;
    });
    const rejected = assert.rejects(saving, { code: "disk_full" });
    await turn();
    assert.equal(calls.length, 1);
    assert.equal(read(), "final");
    replies.shift()('{"value":null}');
    await turn();
    assert.deepEqual(calls[1], ["BayShell", "saveDocument", '["state.json","final"]']);
    assert.equal(acknowledged, false);
    replies.shift()('{"error":{"code":"disk_full","message":"No space"}}');
    await rejected;
    assert.equal(read(), "first", "failed final save restores last acknowledged contents");
    const retry = nativeDocumentSave("state.json", "retry", async () => {});
    await turn();
    replies.shift()('{"value":null}');
    await retry;
    assert.equal(read(), "retry");
  } finally {
    installed.remove();
  }
});

test("Linux sync names use host snapshots and device IDs stay fresh without IPC", () => {
  let invoked = 0;
  const subscription = installNativeTransport(
    transport({
      getHostInfo: () => hostInfo({ platform: "linux", snapshots: { BaySync: { deviceName: "Linux laptop" } } }),
      invoke: async () => {
        invoked++;
        return '{"value":null}';
      },
    }),
  );
  const fallback = () => {
    throw new Error("Synchronous native fallback called");
  };
  try {
    assert.equal(nativeSnapshot("BaySync", "deviceName", [], fallback), "Linux laptop");
    const first = nativeRandomUUID(fallback);
    assert.match(first, /^[a-f0-9-]{36}$/);
    assert.notEqual(nativeRandomUUID(fallback), first);
    assert.equal(invoked, 0);
  } finally {
    subscription.remove();
  }
});
