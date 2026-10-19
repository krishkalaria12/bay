import assert from "node:assert/strict";
import { test } from "node:test";
import { docs, heldSaves } from "../test-native-stub.mjs";

let instance = 0;
const freshStore = () => import(`./store.ts?live-persistence=${++instance}`);

test("importing Live UI neither reads shared documents nor installs a writer", async (t) => {
  docs.clear();
  docs.set("live.json", JSON.stringify({ config: { githubClientId: "saved" } }));
  const read = t.mock.method(docs, "get");
  const write = t.mock.method(docs, "set");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useLive, updateConfig } = await freshStore();
  assert.equal(read.mock.callCount(), 0);
  assert.equal(useLive.getState().config.githubClientId, "");
  updateConfig({ githubClientId: "window-local" });
  t.mock.timers.tick(1000);
  assert.equal(write.mock.callCount(), 0);
});

test("explicit Live startup restores before subscribing and starts only once", async (t) => {
  docs.clear();
  const saved = {
    folderOrder: ["work"],
    config: { githubClientId: "saved" },
    calendar: { alertLead: "5" },
    dismissedAlerts: ["meeting"],
    status: { work: { state: "fetching" } },
  };
  docs.set("live.json", JSON.stringify(saved));
  const read = t.mock.method(docs, "get");
  const write = t.mock.method(docs, "set");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useLive, startLivePersistence, updateConfig, setLive } = await freshStore();
  const stop = startLivePersistence();
  t.after(stop);
  assert.deepEqual(useLive.getState().folderOrder, ["work"]);
  assert.equal(useLive.getState().config.githubClientId, "saved");
  assert.equal(useLive.getState().config.googleClientId, "");
  assert.equal(useLive.getState().calendar.alertLead, "5");
  assert.equal(useLive.getState().calendar.showPreview, true);
  assert.deepEqual(useLive.getState().status, {});
  assert.strictEqual(startLivePersistence(), stop);
  assert.equal(read.mock.callCount(), 1);
  t.mock.timers.tick(800);
  assert.equal(write.mock.callCount(), 0);

  updateConfig({ githubClientId: "new" });
  t.mock.timers.tick(400);
  updateConfig({ googleClientId: "google" });
  t.mock.timers.tick(799);
  assert.equal(write.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(write.mock.callCount(), 1);
  const persisted = JSON.parse(docs.get("live.json"));
  assert.equal(persisted.config.githubClientId, "new");
  assert.equal(persisted.config.googleClientId, "google");
  assert.deepEqual(persisted.dismissedAlerts, ["meeting"]);
  assert.equal("status" in persisted, false);
  assert.equal("completing" in persisted, false);
  assert.equal("showAll" in persisted, false);

  setLive({ status: { work: { state: "fetching" } }, showAll: { work: true } });
  t.mock.timers.tick(800);
  assert.equal(write.mock.callCount(), 1);
});

test("stopping Live persistence cancels pending writes and detaches its subscription", async (t) => {
  docs.clear();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { startLivePersistence, updateConfig } = await freshStore();
  const stop = startLivePersistence();
  t.after(stop);
  updateConfig({ githubClientId: "pending" });
  stop();
  stop();
  t.mock.timers.tick(1000);
  assert.equal(docs.has("live.json"), false);
  updateConfig({ githubClientId: "stopped" });
  t.mock.timers.tick(1000);
  assert.equal(docs.has("live.json"), false);
});

test("invalid Live JSON restores defaults without writing over the document", async (t) => {
  docs.clear();
  docs.set("live.json", "broken JSON");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { startLivePersistence, useLive } = await freshStore();
  t.after(startLivePersistence());
  assert.deepEqual(useLive.getState().folderOrder, []);
  assert.equal(useLive.getState().calendar.showTimeToNext, true);
  t.mock.timers.tick(1000);
  assert.equal(docs.get("live.json"), "broken JSON");
});

test("final Live persistence drains the debounce and waits for disk acknowledgement", async (t) => {
  docs.clear();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { startLivePersistence, flushLivePersistence, updateConfig } = await freshStore();
  const stop = startLivePersistence();
  t.after(() => { heldSaves.on = false; heldSaves.queue.splice(0).forEach(release => release()); stop(); });
  updateConfig({ githubClientId: "before-quit" });
  heldSaves.on = true;
  let saved = false;
  const final = flushLivePersistence({ final: true });
  void final.then(() => { saved = true; });
  assert.strictEqual(flushLivePersistence({ final: true }), final);
  await Promise.resolve();
  assert.equal(saved, false);
  assert.equal(heldSaves.queue.length, 1);
  updateConfig({ githubClientId: "while-closing" });
  t.mock.timers.tick(1000);
  assert.equal(docs.has("live.json"), false);
  heldSaves.queue.splice(0).forEach(release => release());
  await final;
  assert.equal(JSON.parse(docs.get("live.json")).config.githubClientId, "before-quit");
});

test("cancelled Live quit resumes current memory despite a late final acknowledgement", async (t) => {
  docs.clear();
  const { startLivePersistence, flushLivePersistence, resumeLivePersistence, updateConfig, live } = await freshStore();
  const stop = startLivePersistence();
  t.after(() => { heldSaves.on = false; heldSaves.queue.splice(0).forEach(release => release()); stop(); });
  updateConfig({ githubClientId: "old" });
  heldSaves.on = true;
  const final = flushLivePersistence({ final: true });
  updateConfig({ githubClientId: "current" });
  resumeLivePersistence();
  const newer = docs.get("live.json");
  assert.equal(JSON.parse(newer).config.githubClientId, "current");
  heldSaves.queue.splice(0).forEach(release => release());
  await final;
  // The real transport serializes the newer write after the old final save.
  docs.set("live.json", newer);
  assert.equal(live().config.githubClientId, "current");
  heldSaves.on = false;
  updateConfig({ githubClientId: "after-cancellation" });
  await flushLivePersistence();
  assert.equal(JSON.parse(docs.get("live.json")).config.githubClientId, "after-cancellation");
});

test("a failed final Live save rejects and can be saved after cancellation", async (t) => {
  docs.clear();
  const { startLivePersistence, flushLivePersistence, resumeLivePersistence, updateConfig } = await freshStore();
  const stop = startLivePersistence();
  t.after(() => { heldSaves.error = null; stop(); });
  updateConfig({ githubClientId: "retained" });
  heldSaves.error = new Error("disk full");
  await assert.rejects(flushLivePersistence({ final: true }), /disk full/);
  heldSaves.error = null;
  resumeLivePersistence();
  await flushLivePersistence({ final: true });
  assert.equal(JSON.parse(docs.get("live.json")).config.githubClientId, "retained");
});
