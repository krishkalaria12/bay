// The quit handshake (lib/quit.ts): the app saves what it has, answers the native side, and goes on when the
// quit is called off.
import assert from "node:assert/strict";
import { test } from "node:test";

const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browserStore.ts");
const { startPersistence } = await import("./persistenceService.ts");
const { beginQuit, cancelQuit, isQuitting } = await import("./quit.ts");

const S = () => useBrowser.getState();
const change = () => S().updateSettings({ showFullUrl: !S().settings.showFullUrl });

test("the quit saves the session, answers the native side, and freezes the saving", async () => {
  stub.docs.clear();
  stub.writes.length = 0;
  stub.terminated.length = 0;

  const stop = startPersistence();

  try {
    change();
    await beginQuit();

    assert.ok(stub.docs.get("session.json"), "the session is saved before the app answers");
    assert.deepEqual(stub.terminated, [true], "the native side is told the app is ready to go");
    assert.ok(isQuitting());

    const saved = stub.docs.get("session.json");

    // What the quit itself does to the store (its windows closing) is never saved.
    change();
    assert.equal(stub.docs.get("session.json"), saved, "the saving is frozen while the quit is on");
  } finally {
    stop();
  }
});

test("a quit called off goes on with what changed meanwhile", async () => {
  stub.docs.clear();
  stub.writes.length = 0;
  stub.terminated.length = 0;

  const stop = startPersistence();

  try {
    change();
    await beginQuit();

    const saved = stub.docs.get("session.json");

    change();
    cancelQuit();

    assert.ok(!isQuitting(), "the app is not quitting any more");
    assert.notEqual(stub.docs.get("session.json"), saved, "the saving goes on with what changed meanwhile");
  } finally {
    stop();
  }
});

test("native termination waits for the persistence acknowledgement", async (t) => {
  stub.terminated.length = 0;
  const written = Promise.withResolvers();
  t.after(() => cancelQuit({ resume() {} }));
  const pending = beginQuit({ flush: () => written.promise });

  await new Promise(setImmediate);
  assert.deepEqual(stub.terminated, []);
  written.resolve();
  await pending;
  assert.deepEqual(stub.terminated, [true]);
});

test("a cancelled quit ignores an earlier acknowledgement", async () => {
  stub.terminated.length = 0;
  const written = Promise.withResolvers();
  const pending = beginQuit({ flush: () => written.promise });

  await new Promise(setImmediate);
  cancelQuit({ resume() {} });
  written.resolve();
  await pending;
  assert.deepEqual(stub.terminated, []);
  assert.equal(isQuitting(), false);
});

test("a failed save keeps the app open unless quitting anyway is confirmed", async (t) => {
  stub.terminated.length = 0;
  t.after(() => cancelQuit({ resume() {} }));
  const asked = t.mock.method(stub.shellDialogAnswers, "confirm", async () => ({ confirmed: false, suppressed: false }));
  const error = new Error("disk full");

  await beginQuit({ flush: () => Promise.reject(error) });
  assert.deepEqual(stub.terminated, [false]);
  assert.equal(asked.mock.callCount(), 1);
  assert.match(asked.mock.calls[0].arguments[0].message, /disk full/);
});
