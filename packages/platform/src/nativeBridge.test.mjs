import assert from "node:assert/strict";
import { test } from "node:test";
import { bindWindowsModule, decodeNativeResult, validateWindowsBridge } from "./nativeBridge.ts";
import { nativeContracts } from "./nativeContracts.ts";

const bridge = overrides => ({
  contractVersion: 1, modules: ["BayShell", "BayApp"], views: [], constantsJSON: '{"BayApp":{"apiVersion":8}}',
  invoke: async () => JSON.stringify({ value: null }),
  invokeSync: () => JSON.stringify({ value: null }),
  ...overrides,
});

test("optional modules stay absent and stale binaries fail even optional probes", () => {
  assert.equal(bindWindowsModule(bridge(), "BayCalendar", () => {}), null);
  assert.throws(() => bindWindowsModule(bridge({ contractVersion: 2 }), "BayCalendar", () => {}), /contract mismatch/);
  assert.throws(() => validateWindowsBridge(bridge({ modules: null })), /catalog is invalid/);
});
test("native constants retain the application version check", () => {
  const app = bindWindowsModule(bridge(), "BayApp", () => {});
  assert.equal(app.apiVersion, 8);
});
test("native methods preserve sync, async, arguments and errors", async () => {
  const calls = [];
  const native = bridge({
    invoke: async (...args) => { calls.push(args); return '{"value":["main"]}'; },
    invokeSync: (...args) => { calls.push(args); return '{"value":"contents"}'; },
  });
  const shell = bindWindowsModule(native, "BayShell", () => {});
  assert.equal(shell.readDocument("state.json"), "contents");
  assert.deepEqual(await shell.windowIds(), ["main"]);
  assert.deepEqual(calls, [["BayShell", "readDocument", '["state.json"]'], ["BayShell", "windowIds", "[]"]]);
  assert.equal(shell.then, undefined);
  assert.equal(shell.unknownMethod, undefined);
  assert.equal(shell.windowIds, shell.windowIds);
  assert.throws(() => decodeNativeResult('{"error":{"code":"denied","message":"Access denied"}}'), { code: "denied", message: "Access denied" });
  assert.throws(() => decodeNativeResult("null"), /Invalid/);
  assert.throws(() => decodeNativeResult("{}"), /no value/);
  const failed = bindWindowsModule(bridge({ invoke: async () => '{"error":{"code":"cancelled","message":"Cancelled"}}' }), "BayShell", () => {});
  await assert.rejects(failed.windowIds(), { code: "cancelled" });
});
test("subscriptions use module namespaces and removal reaches native emitter", () => {
  const calls = [], listener = () => {}, subscription = { remove() { calls.push("removed"); } };
  const shell = bindWindowsModule(bridge(), "BayShell", (event, callback) => { calls.push([event, callback]); return subscription; });
  assert.equal(shell.addListener("onCommand", listener), subscription);
  subscription.remove();
  assert.deepEqual(calls, [["BayShell.onCommand", listener], "removed"]);
  assert.throws(() => shell.addListener("onInvalid", listener), /Unknown native event/);
});
test("contracts describe core synchronous boot methods and overloaded engine events", () => {
  assert.equal(nativeContracts.modules.BayApp.methods.systemInfo.async, false);
  assert.equal(nativeContracts.modules.BayShell.methods.openWindow.async, true);
  assert.ok(nativeContracts.modules.BayCEF.events.includes("onTabStrip"));
  assert.ok(nativeContracts.modules.BayShell.events.includes("onAppEvent"));
  assert.ok(nativeContracts.views.BayCEF);
});
