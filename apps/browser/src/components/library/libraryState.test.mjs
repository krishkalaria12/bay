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

test("a window's change reaches the others, which take it without writing it again", async () => {
  reset();
  const other = new BroadcastChannel("bay-library");
  const received = new Promise((resolve) => (other.onmessage = ({ data }) => resolve(data)));
  const id = createEasel("work", "Shared");
  const published = await received;
  assert.equal(published.easels[id].title, "Shared");
  assert.equal(JSON.parse(docs.get("library.json")).easels[id].title, "Shared");

  const written = docs.get("library.json");
  const changed = new Promise((resolve) => {
    const stop = useLibrary.subscribe((s) => {
      if (!s.easels.remote) return;
      stop();
      resolve();
    });
  });
  other.postMessage({ ...published, easels: { ...published.easels, remote: { ...published.easels[id], id: "remote", title: "From another window" } } });
  await changed;
  assert.equal(useLibrary.getState().easels.remote.title, "From another window");
  assert.equal(docs.get("library.json"), written, "the window that changed it already saved it");
  other.close();
});

test("Windows paths are local paths, and file names come from either separator", async () => {
  const { fileNameOf, localPath, validItem } = await import("./model.ts");
  for (const path of ["/data/a.png", "C:\\Users\\me\\a.png", "c:/Users/me/a.png", "\\\\server\\share\\a.png"]) assert.equal(localPath(path), true, path);
  for (const path of ["a.png", "https://example.com/a.png", "file:///a.png", 3, undefined]) assert.equal(localPath(path), false);
  assert.equal(fileNameOf("C:\\Users\\me\\a.png"), "a.png");
  assert.equal(fileNameOf("/data/b.png"), "b.png");
  assert.equal(validItem({ id: "i", kind: "image", x: 0, y: 0, width: 1, height: 1, path: "C:\\Bay\\a.png" }), true);
});
