// The app's saving (lib/persistenceService.ts): what is written, when, and what a failed write does.
import assert from "node:assert/strict";
import { test } from "node:test";

const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browserStore.ts");
const { flushPersistence, resumePersistence, startPersistence } = await import("./persistenceService.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writes = (name) => stub.writes.filter((n) => n === name).length;

const change = () => useBrowser.getState().updateSettings({ showFullUrl: !useBrowser.getState().settings.showFullUrl });

test("a burst of changes is one write", async () => {
  stub.docs.clear();
  stub.writes.length = 0;

  const stop = startPersistence();

  try {
    change();
    change();
    change();
    await wait(1_000);

    assert.equal(writes("session.json"), 1);
  } finally {
    stop();
  }
});

test("a write that fails stays dirty, and the next save tries it again", async () => {
  stub.docs.clear();
  stub.writes.length = 0;
  stub.writeErrors.set("session.json", new Error("disk full"));

  const stop = startPersistence();

  try {
    change();
    await wait(1_000);

    // The write was tried and failed: the document is not on disk.
    assert.equal(writes("session.json"), 1);
    assert.equal(stub.docs.get("session.json"), undefined);

    stub.writeErrors.delete("session.json");

    // The failed write is still owed: the flush the quit asks for writes it.
    flushPersistence();
    assert.ok(stub.docs.get("session.json"));
  } finally {
    stub.writeErrors.delete("session.json");
    stop();
  }
});

test("nothing private is written to disk", async () => {
  stub.docs.clear();
  stub.writes.length = 0;

  const stop = startPersistence();

  try {
    const s = useBrowser.getState();

    s.createWindow({ incognito: true });
    // A private window is not written, so something that is written goes with it.
    change();
    await wait(1_000);

    const saved = JSON.parse(stub.docs.get("session.json"));

    assert.equal(
      saved.windows.some((w) => w.incognito),
      false,
    );
    assert.equal(
      saved.tabs.some((t) => String(t.spaceId).startsWith("incognito:")),
      false,
    );
  } finally {
    stop();
  }
});

test("the quit freezes the saving, and a cancelled quit resumes it", async () => {
  stub.docs.clear();
  stub.writes.length = 0;

  const stop = startPersistence();

  try {
    change();
    flushPersistence({ final: true });

    const written = stub.docs.get("session.json");

    // The quit's own changes to the store are never saved.
    change();
    await wait(1_000);
    assert.equal(stub.docs.get("session.json"), written);

    // The quit was cancelled: saving goes on, starting with what changed meanwhile.
    resumePersistence();
    assert.notEqual(stub.docs.get("session.json"), written);
  } finally {
    stop();
  }
});

test("the live folders are saved with the session: one write a burst, again after a failure, and at the quit", async () => {
  const { setLive, live } = await import("../activity/activityStore.ts");
  const { LIVE_DOC } = await import("../activity/constants.ts");

  stub.docs.clear();
  stub.writes.length = 0;

  const stop = startPersistence();
  const fold = () => setLive((s) => ({ expandedStacks: { ...s.expandedStacks, a: !s.expandedStacks.a } }));

  try {
    fold();
    fold();
    fold();
    await wait(1_000);
    assert.equal(writes(LIVE_DOC), 1, "a burst is one write");

    stub.writeErrors.set(LIVE_DOC, new Error("disk full"));
    fold();
    await wait(1_000);
    assert.equal(writes(LIVE_DOC), 2);

    stub.writeErrors.delete(LIVE_DOC);

    // The failed write is still owed, and the quit's flush writes it.
    fold();
    flushPersistence({ final: true });
    assert.equal(JSON.parse(stub.docs.get(LIVE_DOC)).expandedStacks.a, live().expandedStacks.a);

    // While the quit saves, a change waits; a cancelled quit writes it.
    fold();
    await wait(1_000);

    const before = writes(LIVE_DOC);

    resumePersistence();
    assert.equal(writes(LIVE_DOC), before + 1);
  } finally {
    stub.writeErrors.delete(LIVE_DOC);
    resumePersistence();
    stop();
  }
});

test("a rejected final save can retry its frozen snapshot before persistence resumes", async (t) => {
  const { createBrowserStore } = await import("../store/browserStore.ts");
  const { createPersistence } = await import("./persist.ts");
  const browser = createBrowserStore();
  const windowId = browser.getState().createWindow();
  const owner = createPersistence({ store: browser, restoreSession: false });
  t.after(() => {
    stub.heldSaves.error = null;
    owner.dispose();
  });
  stub.heldSaves.error = new Error("disk unavailable");
  await assert.rejects(owner.flush({ final: true }), /disk unavailable/);
  browser.getState().closeWindow(windowId);
  stub.heldSaves.error = null;

  await owner.flush({ final: true });
  assert.equal(JSON.parse(stub.docs.get("session.json")).windows[0].id, windowId);
  owner.resume();
  assert.equal(JSON.parse(stub.docs.get("session.json")).windows.length, 0);
});
