import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

globalThis.require = createRequire(import.meta.url);
const writes = [];
const installed = new Set();
let rejected = new Set();
let afterWrite = () => {};
let storageImported = 0;
let warnings = [];
globalThis.nnTestNativeModules = {
  BayImport: {
    writeExtension: async (browserId, sourceProfile, id, profile) => {
      writes.push({ browserId, sourceProfile, id, profile });
      if (rejected.has(id)) throw new Error("Unsupported manifest");
      const key = `${profile}:${id}`;
      const isNew = !installed.has(key);
      installed.add(key);
      afterWrite();
      return JSON.stringify({ id, installed: isNew, storageImported: isNew ? storageImported : 0, warnings, updateMode: "store" });
    },
  },
};

const { useBrowser } = await import("../../store/browser.ts");
const { engineProfile, setSpaceProfiles } = await import("../../store/model.ts");
const { importExtensions } = await import("./apply.ts");
const extension = (id) => ({ id, name: id, enabled: true, pinned: false });
const source = (profileId, ids, browserId = "arc") => ({ browserId, profileId, extensions: ids.map(extension) });
const reset = () => {
  writes.length = 0;
  installed.clear();
  rejected = new Set();
  afterWrite = () => {};
  storageImported = 0;
  warnings = [];
  useBrowser.getState().hydrate({});
  setSpaceProfiles({});
  const first = useBrowser.getState().settings.defaultSpaceId;
  const second = useBrowser.getState().createSpace({ name: "Work" });
  return [first, second];
};

test("Arc spaces each receive their source profile's extensions and retries retain existing installs", async () => {
  const spaces = reset();
  const data = source("Default", ["one", "two"]);
  const written = await importExtensions(spaces, data);
  assert.equal(written.imported, 4);
  assert.deepEqual(written.failed, []);
  assert.deepEqual(
    writes.map((w) => w.profile),
    [engineProfile(spaces[0]), engineProfile(spaces[0]), engineProfile(spaces[1]), engineProfile(spaces[1])],
  );
  assert.ok(writes.every((w) => w.sourceProfile === "Default" && w.browserId === "arc"));
  assert.equal((await importExtensions(spaces, data)).imported, 0);
});

test("different Chromium profiles keep their extensions in their own destination", async () => {
  const [first, second] = reset();
  await importExtensions([first], source("Default", ["personal"], "dia"));
  await importExtensions([second], source("Profile 2", ["work"], "dia"));
  assert.deepEqual(
    writes.map((w) => [w.sourceProfile, w.id, w.profile]),
    [
      ["Default", "personal", engineProfile(first)],
      ["Profile 2", "work", engineProfile(second)],
    ],
  );
});

test("spaces sharing an engine profile install each extension once", async () => {
  const [first, second] = reset();
  setSpaceProfiles({ [second]: first });
  useBrowser.setState((s) => ({ spaces: { ...s.spaces, [second]: { ...s.spaces[second], profileId: first } } }));
  assert.equal((await importExtensions([first, second], source("Default", ["shared"]))).imported, 1);
  assert.equal(writes.length, 1);
});

test("an incompatible extension is reported for its destination while the others still import", async () => {
  const [first] = reset();
  rejected.add("bad");
  const result = await importExtensions([first], source("Default", ["bad", "good"]));
  assert.equal(result.imported, 1);
  assert.deepEqual(
    result.failed.map((f) => [f.spaceId, f.extension.id, f.message]),
    [[first, "bad", "Unsupported manifest"]],
  );
});

test("cancellation stops before the next extension", async () => {
  const [first] = reset();
  const controller = new AbortController();
  afterWrite = () => controller.abort();
  await assert.rejects(importExtensions([first], source("Default", ["one", "two"]), controller.signal), { code: "cancelled" });
  assert.equal(writes.length, 1);
});

test("cancellation during the final install stops completion after the native write returns", async () => {
  const [first] = reset();
  const controller = new AbortController();
  afterWrite = () => controller.abort();
  await assert.rejects(importExtensions([first], source("Default", ["last"]), controller.signal), { code: "cancelled" });
  assert.equal(writes.length, 1);
});

test("missing and private destinations never install extensions", async () => {
  reset();
  const result = await importExtensions(["missing", "incognito:window"], source("Default", ["one"]));
  assert.equal(result.imported, 0);
  assert.equal(result.failed.length, 2);
  assert.equal(writes.length, 0);
});

test("imported extension settings and native compatibility warnings reach the import summary", async () => {
  const [first] = reset();
  storageImported = 3;
  warnings = ["The imported version needs permission review."];
  const result = await importExtensions([first], source("Default", ["one"]));
  assert.equal(result.storageImported, 3);
  assert.equal(result.notes.length, 1);
  assert.ok(result.notes[0].includes("one"));
  assert.ok(result.notes[0].includes(warnings[0]));
});

test("Firefox addon identifiers pass through to the native compatibility adapter", async () => {
  const [first] = reset();
  const id = "addon@example.org";
  const result = await importExtensions([first], source("Profiles/default", [id], "firefox"));
  assert.equal(result.imported, 1);
  assert.deepEqual(writes[0], { browserId: "firefox", sourceProfile: "Profiles/default", id, profile: engineProfile(first) });
});
