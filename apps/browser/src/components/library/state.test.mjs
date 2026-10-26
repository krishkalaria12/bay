import assert from "node:assert/strict";
import { test } from "node:test";
import { docs, libraryImages } from "../../test-native-stub.mjs";
import {
  addMediaToEasel,
  applyEaselDocument,
  createEasel,
  deleteEasel,
  duplicateEasel,
  removeLibraryMedia,
  saveLibraryMedia,
  startLibrary,
  updateEasel,
  useLibrary,
} from "./state.ts";

const reset = () => {
  docs.clear();
  useLibrary.setState({ version: 1, easels: {}, media: {}, removedMediaPaths: [], loaded: false, error: null });
  startLibrary();
};

test("Easels persist separately from tabs, duplicate without sharing editable item ids, and survive removing Media", async () => {
  reset();
  const id = createEasel("work", "References");
  const media = await saveLibraryMedia({ path: "/tmp/capture.png", width: 1, height: 1 }, "A capture", { url: "https://example.com", title: "Source" });
  assert.ok(media.path.startsWith("/data/Library Media/"));
  assert.equal(media.width, 640, "uses retained image dimensions");
  assert.equal(addMediaToEasel(id, media), true);
  const duplicate = duplicateEasel(id);
  assert.notEqual(useLibrary.getState().easels[id].items[0].id, useLibrary.getState().easels[duplicate].items[0].id);
  removeLibraryMedia(media.id);
  assert.equal(useLibrary.getState().easels[id].items[0].path, media.path);
  const saved = docs.get("library.json");
  useLibrary.setState({ easels: {}, media: {}, removedMediaPaths: [], loaded: false });
  docs.set("library.json", saved);
  startLibrary();
  assert.equal(useLibrary.getState().easels[id].title, "References");
  deleteEasel(id);
  assert.ok(useLibrary.getState().easels[duplicate]);
});

test("failed durable copy never creates dangling media metadata", async () => {
  reset();
  const importer = libraryImages.retain;
  libraryImages.retain = async () => null;
  try {
    assert.equal(await saveLibraryMedia({ path: "/missing", width: 1, height: 1 }, "missing"), null);
    assert.deepEqual(useLibrary.getState().media, {});
  } finally {
    libraryImages.retain = importer;
  }
});

test("native changes reject a different Easel id and invalid geometry; imported images become Media", () => {
  reset();
  const id = createEasel("default");
  const original = useLibrary.getState().easels[id];
  assert.equal(applyEaselDocument(id, JSON.stringify({ ...original, id: "other" })), false);
  const item = { id: "native", kind: "image", x: 0, y: 0, width: 200, height: 100, path: "/data/Library Media/native.png" };
  assert.equal(applyEaselDocument(id, JSON.stringify({ ...original, items: [item] })), true);
  assert.equal(Object.values(useLibrary.getState().media)[0].path, item.path);
  assert.equal(updateEasel(id, { items: [{ ...item, width: -1 }] }), false);
});

test("unreadable Library remains untouched and refuses new writes", () => {
  docs.clear();
  docs.set("library.json", "broken");
  useLibrary.setState({ easels: {}, media: {}, removedMediaPaths: [], loaded: false, error: null });
  startLibrary();
  assert.ok(useLibrary.getState().error);
  assert.equal(createEasel("default"), null);
  assert.equal(docs.get("library.json"), "broken");
});

test("removing Media stays removed when its Easel is edited, undone or reloaded", async () => {
  reset();
  const id = createEasel("default");
  const media = await saveLibraryMedia({ path: "/tmp/removed.png", width: 1, height: 1 }, "Remove this");
  addMediaToEasel(id, media);
  const doc = useLibrary.getState().easels[id];
  removeLibraryMedia(media.id);
  applyEaselDocument(id, JSON.stringify({ ...doc, items: doc.items.map((i) => ({ ...i, x: i.x + 1 })) }));
  assert.deepEqual(useLibrary.getState().media, {});
  applyEaselDocument(id, JSON.stringify({ ...doc, items: [] }));
  applyEaselDocument(id, JSON.stringify(doc));
  assert.deepEqual(useLibrary.getState().media, {});
  const saved = docs.get("library.json");
  useLibrary.setState({ loaded: false });
  docs.set("library.json", saved);
  startLibrary();
  applyEaselDocument(id, JSON.stringify({ ...doc, items: doc.items.map((i) => ({ ...i, x: i.x + 5 })) }));
  assert.deepEqual(useLibrary.getState().media, {});
  assert.ok(useLibrary.getState().easels[id].items[0].path);
});

test("native edit markers survive native changes and clear on external document edits", () => {
  reset();
  const id = createEasel("default");
  const doc = useLibrary.getState().easels[id];
  const item = { id: "t", kind: "text", text: "Idea", x: 0, y: 0, width: 80, height: 40 };
  applyEaselDocument(id, JSON.stringify({ ...doc, items: [item], nativeEditId: "canvas-a-edit-1" }));
  assert.equal(useLibrary.getState().easels[id].nativeEditId, "canvas-a-edit-1");
  updateEasel(id, { items: [] });
  assert.equal(useLibrary.getState().easels[id].nativeEditId, undefined);
});
