import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { decodeSharedCollection, sharedCollectionAppUrl, sharedCollectionToken, sharedCollectionUrl, encodeSharedCollection } from "@bay/core";

const native = new URL("../test-native-stub.mjs", import.meta.url).href;
globalThis.collectionEffects = { copied: [], toasts: [] };
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/lib/collectionSharing.ts")) return next(specifier, context);
    const source =
      specifier === "@bay/shell"
        ? `export * from ${JSON.stringify(native)}; export const copyText = (text) => globalThis.collectionEffects.copied.push(text);`
        : specifier === "../components/layout/toasts"
          ? "export const showToast = (...args) => globalThis.collectionEffects.toasts.push(args);"
          : null;
    return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
  },
});

const { useBrowser } = await import("../store/browser.ts");
const { folderEntries } = await import("../components/sidebar/entries.ts");
const { shellDialogAnswers } = await import("../test-native-stub.mjs");
const { collectionSnapshot, shareCollection, importCollectionUrl, handleSharedCollectionUrl } = await import("./collectionSharing.ts");
const S = () => useBrowser.getState();
const effects = globalThis.collectionEffects;
const collection = { version: 1, kind: "folder", title: "Research", children: [{ kind: "link", title: "Example", url: "https://example.com/article" }] };

function setup() {
  S().hydrate({});
  effects.copied.length = 0;
  effects.toasts.length = 0;
  shellDialogAnswers.confirm = async () => ({ confirmed: false });
  const w = S().createWindow({ url: "https://first.example" });
  const a = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const b = S().newTab(w, { url: "https://second.example" });
  return { w, a, b };
}

test("folder snapshots preserve nested, empty and interleaved entries through import", () => {
  const { w, a, b } = setup();
  const root = S().newPinnedFolder(w, { name: "Research", tabIds: [a, b] });
  const child = S().newPinnedFolder(w, { name: "Nested", parentId: root, tabIds: [b] });
  const empty = S().newPinnedFolder(w, { name: "Empty", parentId: root });
  S().movePinnedFolder(empty, a, root);
  S().updateTab(a, { customTitle: "First renamed", favicon: "private image", customIcon: "private icon", muted: true });
  const snapshot = collectionSnapshot(S(), { kind: "folder", id: root });
  assert.deepEqual(
    snapshot.children.map((item) => item.title),
    ["Nested", "Empty", "First renamed"],
  );
  const imported = S().importSharedCollection(w, snapshot);
  assert.deepEqual(collectionSnapshot(S(), { kind: "folder", id: imported }), snapshot);
  assert.deepEqual(
    folderEntries(S(), root).map((entry) => entry.slice(0, 2)),
    ["f:", "f:", "t:"],
  );
  const payload = JSON.stringify(decodeSharedCollection(encodeSharedCollection(snapshot)));
  for (const secret of [a, b, child, empty, "private image", "private icon", "muted"]) assert.equal(payload.includes(secret), false);
});

test("sharing requires consent before replacing the clipboard and preserves snapshot order", async () => {
  const { w, a, b } = setup();
  const source = { kind: "selection", tabIds: [b, a, b] };
  await shareCollection(w, source);
  assert.deepEqual(effects.copied, []);
  shellDialogAnswers.confirm = async (options) => {
    assert.match(options.message, /Anyone with this link/);
    assert.equal(options.confirmTitle, "Copy Share Link");
    return { confirmed: true };
  };
  await shareCollection(w, source);
  const decoded = decodeSharedCollection(sharedCollectionToken(effects.copied[0]));
  assert.deepEqual(
    decoded.children.map((item) => item.url),
    [S().tabs[b].url, S().tabs[a].url],
  );
  assert.equal(effects.toasts.at(-1)[1], "Share Link Copied");
});

test("split snapshots include every pane in split order", () => {
  const { a, b } = setup();
  const split = S().createSplit([b, a], "vertical");
  const snapshot = collectionSnapshot(S(), { kind: "split", id: split });
  assert.equal(snapshot.kind, "split");
  assert.deepEqual(
    snapshot.children.map((item) => item.url),
    [S().tabs[b].url, S().tabs[a].url],
  );
});

test("private, internal and local-only tabs never reach the clipboard", async () => {
  const { w, a } = setup();
  for (const url of ["bay://history", "file:///Users/person/secret.txt", "http://192.168.1.2/private"]) {
    S().updateTab(a, { url });
    await shareCollection(w, { kind: "selection", tabIds: [a] });
  }
  const privateWindow = S().createWindow({ incognito: true, url: "https://secret.example" });
  const privateTab = S().windows[privateWindow].activeTabIds[S().windows[privateWindow].spaceId];
  assert.throws(() => collectionSnapshot(S(), { kind: "selection", tabIds: [privateTab] }), /Private tabs/);
  assert.deepEqual(effects.copied, []);
});

test("Add to Bay cancellation and malformed links leave all tabs and folders untouched", async () => {
  const { w } = setup();
  const before = S();
  await importCollectionUrl(sharedCollectionAppUrl(encodeSharedCollection(collection)), w);
  assert.equal(S(), before);
  await importCollectionUrl("bay://share/#broken", w);
  assert.equal(S(), before);
  assert.equal(effects.toasts.at(-1)[1], "Cannot Add Shared Folder");
});

test("import confirms its destination and retains that space if the user switches during the dialog", async () => {
  const { w } = setup();
  const spaceId = S().windows[w].spaceId;
  const other = S().createSpace({ name: "Other" });
  shellDialogAnswers.confirm = async (options) => {
    assert.equal(options.confirmTitle, "Add Folder");
    assert.match(options.message, /1 link as a folder/);
    S().switchSpace(w, other);
    return { confirmed: true };
  };
  await importCollectionUrl(sharedCollectionAppUrl(encodeSharedCollection(collection)), w);
  const folder = Object.values(S().pinnedFolders).find((f) => f.name === "Research");
  assert.equal(folder.spaceId, spaceId);
  assert.equal(effects.toasts.at(-1)[1], "Folder Added");
});

test("app links are consumed and deduplicated before ordinary URL routing", async () => {
  const { w } = setup();
  const url = sharedCollectionAppUrl(encodeSharedCollection(collection));
  let confirmations = 0;
  shellDialogAnswers.confirm = async () => (confirmations++, { confirmed: true });
  assert.equal(handleSharedCollectionUrl(sharedCollectionUrl(collection), w), false);
  assert.equal(handleSharedCollectionUrl("bay://settings", w), false);
  assert.equal(handleSharedCollectionUrl(url, w), true);
  assert.equal(handleSharedCollectionUrl(url, w), true);
  await new Promise(setImmediate);
  assert.equal(confirmations, 1);
  assert.equal(Object.keys(S().pinnedFolders).length, 1);
});
