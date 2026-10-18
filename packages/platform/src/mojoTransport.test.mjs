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
