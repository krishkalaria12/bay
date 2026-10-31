import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../store/settings.ts";
import { createBrowserAuthority } from "./authority.ts";
import { createBrowserClient } from "./client.ts";
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fakeTransport() {
  const commits = new Set(),
    closures = new Set(),
    snapshots = [],
    commands = [];
  let released = 0;
  return {
    snapshots,
    commands,
    transport: {
      getSnapshot() {
        const d = deferred();
        snapshots.push(d);
        return d.promise;
      },
      dispatch(request) {
        const d = deferred();
        commands.push({ ...d, request });
        return d.promise;
      },
      subscribeCommits(listener) {
        commits.add(listener);
        return () => {
          released++;
          commits.delete(listener);
        };
      },
      subscribeClose(listener) {
        closures.add(listener);
        return () => {
          released++;
          closures.delete(listener);
        };
      },
    },
    emit(commit) {
      // oxlint-disable-next-line no-useless-spread -- freeze this delivery's subscribers before callbacks run
      for (const listener of [...commits]) listener(commit);
    },
    disconnect() {
      // oxlint-disable-next-line no-useless-spread -- callbacks can unsubscribe during disconnect
      for (const listener of [...closures]) listener();
    },
    get released() {
      return released;
    },
  };
}
const makeAuthority = () => createBrowserAuthority({ epoch: "epoch-1" });
const copy = (value) => JSON.parse(JSON.stringify(value));
const request = (id, command) => ({ epoch: "epoch-1", clientId: "source", requestId: id, command });
async function connect(snapshot) {
  const fake = fakeTransport();
  const client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  await tick();
  fake.snapshots[0].resolve(snapshot);
  await client.ready;
  return { fake, client };
}

test("complete mirror snapshots are detached and expose no local reducer API", async () => {
  const authority = makeAuthority(),
    source = copy(authority.getSnapshot());
  const { fake, client } = await connect(source);
  source.state.settings.sidebarWidth = 1234;
  source.state.spaceOrder.push("injected");
  source.revision = 100;
  assert.equal(client.getStatus(), "ready");
  assert.equal(client.getSnapshot().revision, 0);
  assert.equal(client.getSnapshot().state.settings.sidebarWidth, DEFAULT_SETTINGS.sidebarWidth);
  assert.deepEqual(client.getSnapshot().state.spaceOrder, ["default"]);
  assert.throws(() => {
    client.getSnapshot().state.settings.sidebarWidth = 1;
  }, TypeError);
  for (const name of ["hydrate", "setState", "getState", "createWindow", "newTab"]) assert.ok(!(name in client));
  assert.equal(fake.snapshots.length, 1);
  client.close();
  authority.close();
});

test("commands wait for bootstrap and detach arguments before yielding", async () => {
  const authority = makeAuthority(),
    fake = fakeTransport();
  const client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  const input = { method: "createWindow", options: { url: "https://original.example/", spaceId: undefined } };
  const opened = client.dispatch(input);
  input.options.url = "https://changed.example/";
  await tick();
  assert.equal(client.getSnapshot(), null);
  assert.equal(fake.commands.length, 0);
  fake.snapshots[0].resolve(authority.getSnapshot());
  await client.ready;
  await tick();
  const sent = fake.commands[0];
  assert.deepEqual(sent.request, {
    epoch: "epoch-1",
    clientId: "window-1",
    requestId: 1,
    command: { method: "createWindow", options: { url: "https://original.example/" } },
  });
  assert.ok(Object.isFrozen(sent.request.command.options));
  const reply = await authority.dispatch(sent.request);
  sent.resolve(reply);
  const id = await opened;
  assert.ok(client.getSnapshot().state.windows[id]);
  assert.equal(client.getSnapshot().revision, reply.commit.revision);
  client.close();
  authority.close();
});

test("revision gaps request one complete resync and hold new commands", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const second = await authority.dispatch(request(2, { method: "newTab", windowId: first.value }));
  fake.emit(second.commit);
  const pending = client.dispatch({ method: "reopenClosedWindow" });
  await tick();
  assert.equal(client.getStatus(), "resyncing");
  assert.equal(client.getSnapshot().revision, 0);
  assert.equal(fake.snapshots.length, 2);
  assert.equal(fake.commands.length, 0);
  fake.emit(second.commit);
  assert.equal(fake.snapshots.length, 2);
  fake.snapshots[1].resolve(second.commit);
  await tick();
  assert.equal(client.getStatus(), "ready");
  assert.equal(client.getSnapshot().revision, 2);
  const sent = fake.commands[0];
  sent.resolve(await authority.dispatch(sent.request));
  assert.equal(await pending, null);
  client.close();
  authority.close();
});

test("command replies resolve only after the matching revision is installed", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const pending = client.dispatch({ method: "createWindow" });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await tick();
  const sent = fake.commands[0],
    opened = await authority.dispatch(sent.request);
  const later = await authority.dispatch(request(1, { method: "newTab", windowId: opened.value }));
  sent.resolve({ ...opened, commit: later.commit });
  await tick();
  assert.equal(settled, false);
  assert.equal(client.getStatus(), "resyncing");
  assert.equal(client.getSnapshot().revision, 0);
  fake.snapshots[1].resolve(later.commit);
  assert.equal(await pending, opened.value);
  assert.equal(client.getSnapshot().revision, 2);
  client.close();
  authority.close();
});

test("events during bootstrap cannot be overwritten by an older snapshot", async () => {
  const authority = makeAuthority(),
    initial = authority.getSnapshot();
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const fake = fakeTransport(),
    client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  await tick();
  fake.emit(first.commit);
  fake.snapshots[0].resolve(initial);
  await client.ready;
  assert.equal(client.getSnapshot().revision, 1);
  assert.ok(client.getSnapshot().state.windows[first.value]);
  assert.equal(fake.snapshots.length, 1);
  client.close();
  authority.close();
});

test("duplicate and delayed commits never regress a ready mirror", async () => {
  const authority = makeAuthority(),
    initial = authority.getSnapshot();
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const { fake, client } = await connect(first.commit);
  let changed = 0;
  client.subscribe(() => {
    changed++;
  });
  fake.emit(initial);
  fake.emit(first.commit);
  assert.equal(client.getSnapshot().revision, 1);
  assert.equal(changed, 0);
  assert.equal(fake.snapshots.length, 1);
  client.close();
  authority.close();
});

test("epoch changes reject uncertain commands and require fresh bootstrap", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const pending = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = assert.rejects(pending, { code: "epoch_changed" });
  fake.emit({ ...authority.getSnapshot(), epoch: "epoch-2" });
  await rejected;
  assert.equal(client.getStatus(), "closed");
  assert.equal(client.getSnapshot().epoch, "epoch-1");
  assert.equal(fake.released, 2);
  fake.commands[0].resolve(await authority.dispatch(fake.commands[0].request));
  await tick();
  assert.equal(client.getSnapshot().revision, 0);
  assert.equal(fake.commands.length, 1, "uncertain mutations are never replayed");
  await assert.rejects(client.dispatch({ method: "createWindow" }), { code: "epoch_changed" });
  authority.close();
});

test("transport close rejects bootstrap and queued commands before dispatch", async () => {
  const fake = fakeTransport(),
    client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  const pending = client.dispatch({ method: "createWindow" });
  const rejected = Promise.all([assert.rejects(client.ready, { code: "transport_closed" }), assert.rejects(pending, { code: "transport_closed" })]);
  fake.disconnect();
  await rejected;
  assert.equal(fake.commands.length, 0);
  assert.equal(client.getSnapshot(), null);
  assert.equal(client.getStatus(), "closed");
  assert.equal(fake.released, 2);
});

test("transport close rejects an in-flight mutation immediately", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const pending = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = assert.rejects(pending, { code: "transport_closed" });
  fake.disconnect();
  await rejected;
  assert.equal(fake.commands.length, 1);
  authority.close();
});

test("normal command rejection leaves the client usable", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const failed = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = assert.rejects(failed, /command refused/);
  fake.commands[0].reject(new Error("command refused"));
  await rejected;
  const next = client.dispatch({ method: "createWindow" });
  await tick();
  const sent = fake.commands[1];
  assert.equal(sent.request.requestId, 2);
  sent.resolve(await authority.dispatch(sent.request));
  assert.ok(await next);
  assert.equal(client.getStatus(), "ready");
  client.close();
  authority.close();
});

test("stale-epoch rejection fails all pending mutations", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const a = client.dispatch({ method: "createWindow" }),
    b = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = Promise.all([assert.rejects(a, { code: "epoch_changed" }), assert.rejects(b, { code: "epoch_changed" })]);
  fake.commands[0].reject(Object.assign(new Error("stale"), { code: "stale_epoch" }));
  await rejected;
  assert.equal(client.getStatus(), "closed");
  authority.close();
});

for (const [name, damage] of [
  [
    "negative revision",
    (s) => {
      s.revision = -1;
    },
  ],
  [
    "fractional revision",
    (s) => {
      s.revision = 0.5;
    },
  ],
  [
    "missing slice",
    (s) => {
      delete s.state.tabs;
    },
  ],
  [
    "wrong slice type",
    (s) => {
      s.state.windows = [];
    },
  ],
  [
    "incomplete settings",
    (s) => {
      s.state.settings = {};
    },
  ],
  [
    "invalid focus state",
    (s) => {
      s.state.ui.focusOrder = [2];
    },
  ],
  [
    "function in state",
    (s) => {
      s.state.tabs.bad = () => {};
    },
  ],
])
  test(`malformed bootstrap rejects ${name} before installation`, async () => {
    const authority = makeAuthority(),
      snapshot = copy(authority.getSnapshot());
    damage(snapshot);
    const fake = fakeTransport(),
      client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
    await tick();
    const rejected = assert.rejects(client.ready, { code: "invalid_protocol" });
    fake.snapshots[0].resolve(snapshot);
    await rejected;
    assert.equal(client.getSnapshot(), null);
    assert.equal(client.getStatus(), "closed");
    authority.close();
  });

test("malformed replies cannot change the mirror", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const pending = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = assert.rejects(pending, { code: "invalid_protocol" }),
    reply = await authority.dispatch(fake.commands[0].request);
  fake.commands[0].resolve({ ...reply, requestId: 100 });
  await rejected;
  assert.equal(client.getSnapshot().revision, 0);
  authority.close();
});

test("resync rejects snapshots older than an observed revision without looping", async () => {
  const authority = makeAuthority(),
    initial = authority.getSnapshot(),
    { fake, client } = await connect(initial);
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const second = await authority.dispatch(request(2, { method: "newTab", windowId: first.value }));
  fake.emit(second.commit);
  await tick();
  fake.snapshots[1].resolve(initial);
  await tick();
  assert.equal(client.getStatus(), "closed");
  assert.equal(client.getSnapshot().revision, 0);
  assert.equal(fake.snapshots.length, 2);
  authority.close();
});

test("snapshot failure rejects bootstrap and pending commands", async () => {
  const fake = fakeTransport(),
    client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  const pending = client.dispatch({ method: "createWindow" });
  await tick();
  const rejected = Promise.all([assert.rejects(client.ready, { code: "snapshot_failed" }), assert.rejects(pending, { code: "snapshot_failed" })]);
  fake.snapshots[0].reject(new Error("unavailable"));
  await rejected;
  assert.equal(client.getSnapshot(), null);
  assert.equal(fake.commands.length, 0);
});

test("closing before a scheduled dispatch prevents that unsent mutation", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const pending = client.dispatch({ method: "createWindow" });
  const rejected = assert.rejects(pending, { code: "closed" });
  client.close();
  await rejected;
  await tick();
  assert.equal(fake.commands.length, 0);
  authority.close();
});

test("a synchronous transport close releases subscriptions and skips bootstrap", async () => {
  let released = 0,
    reads = 0;
  const transport = {
    subscribeCommits() {
      return () => {
        released++;
      };
    },
    subscribeClose(listener) {
      listener();
      return () => {
        released++;
      };
    },
    getSnapshot() {
      reads++;
      throw new Error("should not read");
    },
    dispatch() {
      throw new Error("should not dispatch");
    },
  };
  const client = createBrowserClient({ clientId: "window-1", transport });
  await assert.rejects(client.ready, { code: "transport_closed" });
  assert.equal(released, 2);
  assert.equal(reads, 0);
});

test("a gap before the scheduled send holds that command through resync", async () => {
  const authority = makeAuthority(),
    { fake, client } = await connect(authority.getSnapshot());
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const second = await authority.dispatch(request(2, { method: "newTab", windowId: first.value }));
  const pending = client.dispatch({ method: "reopenClosedWindow" });
  fake.emit(second.commit);
  await tick();
  assert.equal(fake.commands.length, 0);
  fake.snapshots[1].resolve(second.commit);
  await tick();
  assert.equal(fake.commands.length, 1);
  const sent = fake.commands[0];
  sent.resolve(await authority.dispatch(sent.request));
  assert.equal(await pending, null);
  client.close();
  authority.close();
});

test("unchanged JSON nodes keep their identities across full snapshot commits", async () => {
  const authority = makeAuthority();
  const first = await authority.dispatch(request(1, { method: "createWindow", options: { url: "https://one.example/" } }));
  const second = await authority.dispatch(request(2, { method: "newTab", windowId: first.value, options: { url: "https://two.example/" } }));
  const { fake, client } = await connect(copy(second.commit));
  const before = client.getSnapshot().state,
    unchanged = second.value,
    active = Object.keys(before.tabs).find((id) => id !== unchanged);
  const changed = await authority.dispatch(request(3, { method: "navigate", tabId: active, url: "https://changed.example/" }));
  const incoming = copy(changed.commit);
  fake.emit(incoming);
  const after = client.getSnapshot().state;
  assert.equal(after.settings, before.settings);
  assert.equal(after.spaces, before.spaces);
  assert.equal(after.groups, before.groups);
  assert.equal(after.tabs[unchanged], before.tabs[unchanged]);
  assert.notEqual(after.tabs[active], before.tabs[active]);
  incoming.state.tabs[unchanged].title = "changed after delivery";
  assert.notEqual(after.tabs[unchanged].title, "changed after delivery");
  assert.ok(!Object.isFrozen(incoming.state.tabs[unchanged]));
  client.close();
  authority.close();
});

test("a command held by resync rejects replies predating its actual send", async () => {
  const authority = makeAuthority(),
    initial = authority.getSnapshot(),
    { fake, client } = await connect(initial);
  const first = await authority.dispatch(request(1, { method: "createWindow" }));
  const second = await authority.dispatch(request(2, { method: "newTab", windowId: first.value }));
  const pending = client.dispatch({ method: "reopenClosedWindow" });
  fake.emit(second.commit);
  await tick();
  fake.snapshots[1].resolve(second.commit);
  await tick();
  const sent = fake.commands[0],
    rejected = assert.rejects(pending, { code: "invalid_protocol" });
  sent.resolve({ clientId: "window-1", requestId: sent.request.requestId, value: null, commit: initial });
  await rejected;
  assert.equal(client.getSnapshot().revision, 2);
  assert.equal(client.getStatus(), "closed");
  authority.close();
});

test("a window that opens while the runtime isn't ready asks again, and says why if it never is", async () => {
  const authority = makeAuthority(),
    fake = fakeTransport();
  const notReady = () => Object.assign(new Error("Application state is not ready"), { code: "not_ready" });
  const client = createBrowserClient({ clientId: "window-1", transport: fake.transport });
  await tick();
  fake.snapshots[0].reject(notReady());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.snapshots.length, 2);
  fake.snapshots[1].resolve(authority.getSnapshot());
  await client.ready;
  assert.equal(client.getStatus(), "ready");

  const other = fakeTransport();
  const failing = createBrowserClient({ clientId: "window-2", transport: other.transport });
  await tick();
  other.snapshots[0].reject(new Error("projection refused"));
  await assert.rejects(failing.ready, /browser runtime snapshot failed: projection refused/);
});
