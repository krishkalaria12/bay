import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "./browser.ts";
import { localFilePath, localFilePins, normalizeLocalFiles } from "./localFiles.ts";

const S = () => useBrowser.getState();
const pdf = { path: "/Users/owner/Documents/A #1.pdf", name: "A #1.pdf", kind: "file" };
const folder = { path: "/Users/owner/Documents/Work", name: "Work", kind: "folder" };
const setup = () => {
  S().hydrate({});
  return S().createWindow({});
};

test("a Finder batch pins once, deduplicates paths per space and preserves metadata across hydrate", () => {
  const w = setup();
  let writes = 0;
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.localFiles !== prev.localFiles) writes++;
  });
  const [a, b] = S().pinLocalFiles(w, [pdf, folder]);
  stop();
  assert.equal(writes, 1);
  assert.deepEqual(
    localFilePins(S(), "default").map((pin) => pin.name),
    [pdf.name, folder.name],
  );
  assert.deepEqual(S().pinLocalFiles(w, [{ ...pdf, path: "/Users//owner/Documents/A #1.pdf/" }]), [a]);
  S().setLocalFileExpanded(b, true);
  const saved = { spaces: S().spaces, localFiles: S().localFiles };
  S().hydrate(saved);
  assert.equal(S().localFiles[a].path, pdf.path);
  assert.equal(S().localFiles[b].expanded, true);
});

test("file mutations rename pins, reorder within the space and restore undo without touching another space", () => {
  const w = setup();
  const [a, b] = S().pinLocalFiles(w, [pdf, folder]);
  const other = S().createSpace({ name: "Other" });
  const [c] = S().pinLocalFiles(w, [pdf], other);
  const before = { ...S().localFiles };
  S().renameLocalFile(a, "  My report  ");
  assert.equal(S().localFiles[a].name, "My report");
  assert.equal(S().localFiles[a].path, pdf.path);
  S().moveLocalFile(b, a);
  assert.deepEqual(
    localFilePins(S(), "default").map((pin) => pin.id),
    [b, a],
  );
  S().moveLocalFile(a, c);
  assert.deepEqual(
    localFilePins(S(), "default").map((pin) => pin.id),
    [b, a],
  );
  S().removeLocalFile(a);
  S().renameLocalFile(c, "Other edit");
  S().restoreLocalFiles("default", before);
  assert.deepEqual(
    localFilePins(S(), "default").map((pin) => pin.id),
    [a, b],
  );
  assert.equal(S().localFiles[c].name, "Other edit");
});

test("private and Little Bay windows never accept file pins", () => {
  setup();
  const privateWindow = S().createWindow({ incognito: true });
  const small = S().createWindow({ small: true });
  assert.deepEqual(S().pinLocalFiles(privateWindow, [pdf]), []);
  assert.deepEqual(S().pinLocalFiles(small, [pdf]), []);
  assert.deepEqual(S().pinLocalFiles("gone", [pdf]), []);
  assert.deepEqual(S().localFiles, {});
});

test("disk metadata whitelisting rejects traversal, poisoned ids, private spaces and strips grants", () => {
  const value = { ...pdf, id: "a", spaceId: "default", createdAt: 10, order: 2, expanded: true, bookmark: "secret", access: "available" };
  const clean = normalizeLocalFiles({ a: value }, { default: {} });
  assert.deepEqual(clean.a, { ...pdf, id: "a", spaceId: "default", createdAt: 10, order: 2, expanded: false });
  for (const patch of [
    { id: "__proto__" },
    { id: "constructor" },
    { path: "file:///tmp/a" },
    { path: "/tmp/../secret" },
    { spaceId: "incognito:w" },
    { spaceId: "missing" },
    { kind: "url" },
  ]) {
    assert.deepEqual(normalizeLocalFiles({ a: { ...value, ...patch } }, { default: {} }), {});
  }
  assert.equal(localFilePath("/tmp/./secret"), null);
  assert.equal(localFilePath("/tmp/secret\0.pdf"), null);
  assert.equal(localFilePath("/a//b/"), "/a/b");
});

test("removing a space removes its pins while closing a window keeps them", () => {
  const w = setup();
  const other = S().createSpace({ name: "Other" });
  const [id] = S().pinLocalFiles(w, [pdf], other);
  S().closeWindow(w);
  assert.ok(S().localFiles[id]);
  S().deleteSpace(other);
  assert.equal(S().localFiles[id], undefined);
});
