import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { installNativeTransport } from "../../../../packages/platform/src/nativeBridge.ts";

// Exercise the real web binding and generated contract, rather than the app's
// native stub, so optional capability advertisement participates in startup.
const native = new URL("../../../../packages/platform/src/native.web.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@bay/platform/native" ? { url: native, shortCircuit: true } : next(specifier, context);
  },
});
const info = { contractVersion: 2, platform: "windows", modules: ["BayCEF"], views: [], constants: {}, optionalMethods: [] };
const calls = [],
  listeners = new Set();
let denied = false;
const connection = installNativeTransport({
  getHostInfo: () => info,
  async invoke(module, method, args) {
    calls.push({ module, method, args });
    if (denied) return JSON.stringify({ error: { code: "forbidden", message: "Only the coordinator may subscribe" } });
    if (method === "startPageEvents") for (const listener of listeners) listener({ tabId: "native-tab" });
    return JSON.stringify({ value: null });
  },
  subscribe(module, event, listener) {
    assert.equal(module, "BayCEF");
    assert.equal(event, "onPageEvent");
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
});
after(() => connection.remove());
const { onPageEvent, startPageEvents, stopPageEvents } = await import("../../../../packages/nncore/src/pageEvents.ts");

test("coordinator page startup requires advertised native support and subscribes before replay", async () => {
  await assert.rejects(startPageEvents(), /not supported/);
  assert.equal(calls.length, 0);
  info.optionalMethods = ["BayCEF.startPageEvents", "BayCEF.stopPageEvents"];
  const received = [];
  const subscription = onPageEvent((fact) => received.push(fact));
  await startPageEvents();
  assert.deepEqual(received, [{ tabId: "native-tab" }]);
  subscription.remove();
  await stopPageEvents();
  assert.equal(listeners.size, 0);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["startPageEvents", "stopPageEvents"],
  );
  assert.ok(calls.every(({ module, args }) => module === "BayCEF" && args === "[]"));
  denied = true;
  await assert.rejects(startPageEvents(), { code: "forbidden" });
});
