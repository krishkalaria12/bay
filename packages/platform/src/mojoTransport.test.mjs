import assert from "node:assert/strict";
import test from "node:test";
import { createMojoTransport, initializeWebNativeBridge } from "./mojoTransport.ts";
import { bindNativeModule, getNativeHostInfo } from "./nativeBridge.ts";

const info = overrides => ({ contractVersion: 2, platform: "windows", modules: ["BayShell"], views: [], constants: {}, snapshots: {}, ...overrides });
function endpoints(overrides = {}) {
  let nextId = 1, closed = 0;
  const callbacks = new Map(), calls = [];
  const event = name => ({ addListener(callback) { const id = nextId++; callbacks.set(id, { name, callback }); return id; } });
  const client = { onNativeEvent: event("event"), onHostInfoChanged: event("info"), removeListener: id => callbacks.delete(id), $: { bindNewPipeAndPassRemote: () => "client", close: () => closed++ } };
  const remote = { getHostInfo: async () => ({ infoJson: JSON.stringify(info()) }), invoke: async (...args) => { calls.push(args); return { resultJson: '{"value":["main"]}' }; }, setClient: client => calls.push(["client", client]), $: { close: () => closed++ }, ...overrides };
  return { client, remote, calls, callbacks, closed: () => closed, emit: (name, ...args) => { for (const item of [...callbacks.values()]) if (item.name === name) item.callback(...args); } };
}
test("Mojo carries JSON contracts and isolates/removes event subscriptions", async () => {
  const native = endpoints(), transport = await createMojoTransport(native);
  const shell = bindNativeModule(transport, "BayShell"), received = [];
  const first = shell.addListener("onCommand", e => received.push(e));
  const other = transport.subscribe("BayApp", "onCommand", () => { throw new Error("wrong module"); });
  native.emit("event", "BayShell", "onCommand", '{"command":"newTab"}');
  assert.deepEqual(received, [{ command: "newTab" }]);
  first.remove(); first.remove();
  native.emit("event", "BayShell", "onCommand", '{"command":"newWindow"}');
  assert.equal(received.length, 1);
  assert.deepEqual(await shell.windowIds(), ["main"]);
  assert.deepEqual(native.calls, [["client", "client"], ["BayShell", "windowIds", "[]"]]);
  const windowIds = shell.windowIds;
  other.remove(); transport.dispose(); transport.dispose();
  assert.equal(native.callbacks.size, 0); assert.equal(native.closed(), 2);
  await assert.rejects(windowIds(), { code: "transport_closed" });
});
test("newer host info received during initialization wins over old initial snapshot", async () => {
  let resolve;
  const native = endpoints({ getHostInfo: () => new Promise(done => { resolve = done; }) });
  const ready = createMojoTransport(native);
  native.emit("info", JSON.stringify(info({ platform: "linux" })));
  resolve({ infoJson: JSON.stringify(info()) });
  const transport = await ready;
  assert.equal(transport.getHostInfo().platform, "linux");
  transport.dispose();
});
test("invalid host updates fail the transport and malformed events report errors", async () => {
  const native = endpoints(), errors = [];
  const transport = await createMojoTransport({ ...native, onProtocolError: error => errors.push(error) });
  native.emit("event", "BayShell", "onCommand", "{broken");
  assert.equal(errors[0].code, "invalid_event");
  native.emit("info", JSON.stringify(info({ contractVersion: 999 })));
  assert.equal(errors[1].code, "contract_mismatch");
  assert.throws(() => transport.getHostInfo(), { code: "contract_mismatch" });
  await assert.rejects(transport.invoke("BayShell", "windowIds", "[]"), { code: "contract_mismatch" });
  transport.dispose();
});
test("failed bootstrap closes both Mojo endpoints and removes listeners", async () => {
  const native = endpoints({ getHostInfo: async () => { throw new Error("disconnected"); } });
  await assert.rejects(createMojoTransport(native), /disconnected/);
  assert.equal(native.closed(), 2); assert.equal(native.callbacks.size, 0);
});
test("unresponsive bootstrap times out and closes endpoints before a late reply", async () => {
  let resolve;
  const native = endpoints({ getHostInfo: () => new Promise(done => { resolve = done; }) });
  await assert.rejects(createMojoTransport({ ...native, bootstrapTimeoutMs: 5 }), { code: "bootstrap_timeout" });
  assert.equal(native.closed(), 2); assert.equal(native.callbacks.size, 0);
  resolve({ infoJson: JSON.stringify(info()) });
  await Promise.resolve();
  assert.equal(native.closed(), 2);
});
test("web bootstrap installs host identity before application imports", async () => {
  const native = endpoints(), installed = await initializeWebNativeBridge(native);
  assert.equal(getNativeHostInfo().platform, "windows");
  installed.remove();
});

test("duplicate callback registrations remain independent subscriptions", async () => {
  const native = endpoints(), transport = await createMojoTransport(native);
  let count = 0;
  const callback = () => count++;
  const first = transport.subscribe("BayShell", "onCommand", callback);
  const second = transport.subscribe("BayShell", "onCommand", callback);
  native.emit("event", "BayShell", "onCommand", "null");
  assert.equal(count, 2);
  first.remove();
  native.emit("event", "BayShell", "onCommand", "null");
  assert.equal(count, 3);
  second.remove(); transport.dispose();
});

const notification = (native, payload) => native.emit("event", "BayApp", "onNotificationResponse", JSON.stringify(payload));
const drain = () => new Promise(queueMicrotask);

test("notification activations emitted by SetClient and during bootstrap replay after subscription", async () => {
  let finishBootstrap;
  const native = endpoints({
    setClient() { notification(native, { id: "cold-start" }); },
    getHostInfo: () => new Promise(resolve => { finishBootstrap = resolve; }),
  });
  const ready = createMojoTransport(native);
  notification(native, { id: "during-bootstrap" });
  finishBootstrap({ infoJson: JSON.stringify(info()) });
  const transport = await ready, received = [];
  transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload));
  assert.deepEqual(received, [], "subscription never synchronously invokes application code");
  await drain();
  assert.deepEqual(received, [{ id: "cold-start" }, { id: "during-bootstrap" }]);
  transport.dispose();
});

test("notification replay stays ordered with events arriving before and during its drain", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), received = [];
  notification(native, 1);
  transport.subscribe("BayApp", "onNotificationResponse", payload => {
    received.push(payload);
    if (payload === 1) notification(native, 4);
  });
  notification(native, 2); notification(native, 3);
  await drain(); await drain();
  assert.deepEqual(received, [1, 2, 3, 4]);
  notification(native, 5);
  assert.deepEqual(received, [1, 2, 3, 4, 5], "live delivery remains immediate once replay completes");
  transport.dispose();
});

test("a throwing notification replay subscriber does not interrupt other subscribers or later responses", async () => {
  const native = endpoints(), errors = [], received = [];
  const transport = await createMojoTransport({ ...native, onProtocolError: error => errors.push(error) });
  notification(native, 1);
  transport.subscribe("BayApp", "onNotificationResponse", () => { throw new Error("subscriber failed"); });
  transport.subscribe("BayApp", "onNotificationResponse", payload => {
    received.push(payload);
    if (payload === 2) notification(native, 3);
  });
  notification(native, 2);
  await drain(); await drain();
  assert.deepEqual(received, [1, 2, 3]);
  assert.deepEqual(errors.map(error => error.message), ["subscriber failed", "subscriber failed", "subscriber failed"]);
  transport.dispose();
});

test("unsubscribing before a drain retains notification responses for the next subscriber", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), first = [], next = [];
  notification(native, 1);
  const subscription = transport.subscribe("BayApp", "onNotificationResponse", payload => first.push(payload));
  subscription.remove(); await drain();
  notification(native, 2);
  transport.subscribe("BayApp", "onNotificationResponse", payload => next.push(payload));
  await drain();
  assert.deepEqual(first, []); assert.deepEqual(next, [1, 2]);
  transport.dispose();
});

test("notification retention evicts the oldest responses after the count limit", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), received = [];
  for (let i = 0; i < 40; i++) notification(native, i);
  transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload));
  await drain();
  assert.deepEqual(received, Array.from({ length: 32 }, (_, index) => index + 8));
  transport.dispose();
});

test("notification retention bounds UTF-8 bytes and drops an oversized response", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), received = [];
  // Each response is about 180 KiB in UTF-8 but only 60 Ki UTF-16 code units.
  notification(native, { id: 1, text: "界".repeat(60 * 1024) });
  notification(native, { id: 2, text: "界".repeat(60 * 1024) });
  notification(native, { id: "too-large", text: "界".repeat(100 * 1024) });
  notification(native, { id: "too-many-code-units", text: "x".repeat(256 * 1024) });
  transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload.id));
  await drain();
  assert.deepEqual(received, [2]);
  transport.dispose();
});

test("disposing before notification replay prevents queued delivery", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), received = [];
  notification(native, { id: "queued" });
  transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload));
  transport.dispose(); await drain();
  assert.deepEqual(received, []); assert.equal(native.callbacks.size, 0);
});

test("only notification responses retain events and delivered responses do not replay", async () => {
  const native = endpoints(), transport = await createMojoTransport(native), received = [];
  native.emit("event", "BayApp", "onCommand", '"app-command"');
  native.emit("event", "BayShell", "onNotificationResponse", '"other-module"');
  native.emit("event", "BayApp", "onNativeEvent", '"other-event"');
  const subscriptions = [
    transport.subscribe("BayApp", "onCommand", payload => received.push(payload)),
    transport.subscribe("BayShell", "onNotificationResponse", payload => received.push(payload)),
    transport.subscribe("BayApp", "onNativeEvent", payload => received.push(payload)),
    transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload)),
  ];
  notification(native, "delivered");
  await drain(); assert.deepEqual(received, ["delivered"]);
  subscriptions.forEach(subscription => subscription.remove());
  transport.subscribe("BayApp", "onNotificationResponse", payload => received.push(payload));
  await drain(); assert.deepEqual(received, ["delivered"]);
  transport.dispose();
});
