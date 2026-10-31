import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { installNativeTransport } from "./nativeBridge.ts";

// Resolve the web adapters and real shell facade without loading native views.
const appURL = new URL("../../shell/src/app.ts", import.meta.url).href;
const shellURL = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(appURL)}; export const confirm = async () => { throw new Error("Unexpected permission prompt"); };`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@bay/platform") return { url: new URL("./os.web.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "@bay/platform/native") return { url: new URL("./native.web.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "@bay/shell") return { url: shellURL, shortCircuit: true };
    return next(specifier, context);
  },
});

test("notification preflight follows the real host method contract", async (t) => {
  const calls = [];
  const info = {
    contractVersion: 2,
    platform: "linux",
    modules: ["BayApp", "BayNotifications"],
    views: [],
    constants: {},
    optionalMethods: ["BayApp.postNotification", "BayApp.removeNotifications"],
  };
  let permission = "granted";
  const connection = installNativeTransport({
    getHostInfo: () => info,
    invoke: async (module, method) => {
      calls.push(`${module}.${method}`);
      return JSON.stringify({ value: method === "notificationPermission" ? permission : true });
    },
    subscribe: () => ({ remove() {} }),
  });
  t.after(() => connection.remove());
  const app = await import(appURL);
  const { ensureNotificationPermission } = await import("../../../apps/browser/src/lib/notificationPermission.ts");

  assert.equal(app.hasNotificationPermissionQuery(), false);
  assert.equal(await ensureNotificationPermission(), true);
  await assert.rejects(app.notificationPermission(), /unavailable/);
  await assert.rejects(app.requestNotificationPermission(), /unavailable/);
  await assert.rejects(app.openNotificationSettings(), /unavailable/);
  assert.deepEqual(calls, []);

  info.platform = "windows";
  info.optionalMethods.push("BayApp.notificationPermission", "BayApp.requestNotificationPermission", "BayApp.openNotificationSettings");
  assert.equal(app.hasNotificationPermissionQuery(), true);
  assert.equal(await ensureNotificationPermission(), true);
  assert.deepEqual(calls, ["BayApp.notificationPermission"]);
  permission = "notDetermined";
  assert.equal(await ensureNotificationPermission(), true);
  assert.deepEqual(calls.slice(1), ["BayApp.notificationPermission", "BayApp.requestNotificationPermission"]);

  // The bridge must hide a cached method when a later host snapshot omits it.
  info.optionalMethods = [];
  assert.equal(app.hasNotificationPermissionQuery(), false);
});
