import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../store/browser.ts";
import { docs, heldSaves } from "../test-native-stub.mjs";
import { flushPersistence, resumePersistence, startPersistence } from "./persist.ts";

test("final persistence waits for disk acknowledgements and freezes closing windows", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  heldSaves.on = true;
  try {
    const windowId = useBrowser.getState().createWindow({ url: "https://saved.example/" });
    let done = false;
    const final = flushPersistence({ final: true }).then(() => { done = true; });
    assert.equal(heldSaves.queue.length, 2);
    useBrowser.getState().closeWindow(windowId);
    assert.strictEqual(flushPersistence({ final: true }), flushPersistence({ final: true }));
    await Promise.resolve();
    assert.equal(done, false);
    heldSaves.queue.splice(0).forEach(release => release());
    await final;
    assert.equal(done, true);
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
    heldSaves.on = false;
    resumePersistence();
    assert.equal(JSON.parse(docs.get("session.json")).windows.length, 0);
  } finally {
    heldSaves.on = false;
    heldSaves.queue.splice(0).forEach(release => release());
    resumePersistence();
    stop();
  }
});

test("failed final writes reject quit and can be saved after cancellation", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  try {
    const windowId = useBrowser.getState().createWindow({ url: "https://retry.example/" });
    heldSaves.error = new Error("disk full");
    await assert.rejects(flushPersistence({ final: true }), /disk full/);
    heldSaves.error = null;
    resumePersistence();
    assert.equal(JSON.parse(docs.get("session.json")).windows[0].id, windowId);
    await flushPersistence({ final: true });
  } finally {
    heldSaves.error = null;
    resumePersistence();
    stop();
  }
});

test("a final save acknowledged after cancellation cannot replace the newer save cache", async () => {
  docs.clear();
  useBrowser.getState().hydrate({});
  const stop = startPersistence();
  heldSaves.on = true;
  try {
    useBrowser.getState().createWindow({ url: "https://cancel.example/" });
    const final = flushPersistence({ final: true });
    useBrowser.getState().updateSettings({ appearance: "dark" });
    resumePersistence();
    const newer = docs.get("session.json");
    heldSaves.queue.splice(0).forEach(release => release());
    await final;
    // Native's newer write is ordered after the pending final save.
    docs.set("session.json", newer);
    useBrowser.getState().updateSettings({ appearance: "auto" });
    await flushPersistence();
    assert.equal(JSON.parse(docs.get("session.json")).settings.appearance, "auto");
  } finally {
    heldSaves.on = false;
    heldSaves.queue.splice(0).forEach(release => release());
    resumePersistence();
    stop();
  }
});
