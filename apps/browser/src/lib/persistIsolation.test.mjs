import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browser.ts");
const { loadSession, startPersistence } = await import("./persist.ts");
const { engineProfile } = await import("../store/model.ts");

const legacy = () => ({
  version: 2,
  profiles: {
    default: { id: "default", name: "Personal", color: "blue", icon: null, createdAt: 0 },
    work: { id: "work", name: "Work", color: "green", icon: null, createdAt: 1, profileId: "default" },
  },
  profileOrder: ["work", "default"],
  windows: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});

test("legacy profile names restore, shared profiles split durably, and original session stays backed up", () => {
  stub.docs.clear();
  const original = JSON.stringify(legacy());
  stub.docs.set("session.json", original);
  const stop = startPersistence();
  assert.notEqual(engineProfile("default"), engineProfile("work"));
  const saved = JSON.parse(stub.docs.get("session.json"));
  assert.ok(saved.spaces.work);
  assert.equal(saved.spaces.work.profileId, undefined);
  assert.equal(stub.docs.get("session.before-space-isolation.json"), original);
  stop();
  const restored = loadSession();
  useBrowser.getState().hydrate(restored);
  assert.equal(engineProfile("work"), "work");
  assert.equal(stub.docs.get("session.before-space-isolation.json"), original);
});

test("legacy cache migrations retain shared data only in the original owner", () => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(legacy()));
  const list = [{ url: "https://private.example", title: "Private", visits: 1, lastVisit: 100 }];
  const history = JSON.stringify({ history: { work: list } });
  const roots = { bar: "old-bar", other: "old-other" };
  const bookmarks = JSON.stringify({ bookmarks: { nodes: {}, roots: { work: roots } } });
  stub.docs.set("history.json", history);
  stub.docs.set("bookmarks.json", bookmarks);
  loadSession();
  assert.deepEqual(JSON.parse(stub.docs.get("history.json")).history, { default: list });
  assert.deepEqual(JSON.parse(stub.docs.get("bookmarks.json")).bookmarks.roots, { default: roots });
  assert.equal(stub.docs.get("history.before-space-isolation.json"), history);
  assert.equal(stub.docs.get("bookmarks.before-space-isolation.json"), bookmarks);
  loadSession();
  assert.equal(stub.docs.get("history.before-space-isolation.json"), history);
  assert.deepEqual(JSON.parse(stub.docs.get("history.json")).history, { default: list });
});
