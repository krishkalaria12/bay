import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../../store/browser.ts";
import { createLocalBrowserReadSource, installBrowserReadSource } from "../../store/read.ts";
import { createLocalBrowserCommands, installBrowserCommands } from "../../runtime/commands.ts";
import { listIds, spaceListKey } from "../../store/model.ts";
import { importTabs, importBookmarks, importArcSpace, destinationProfile } from "./commands.ts";
import { sidebarEntries, folderEntries } from "../sidebar/entries.ts";

function setup(t) {
  const store = createBrowserStore();
  store.getState().hydrate({});
  const local = createLocalBrowserCommands(store),
    commands = [];
  const restoreRead = installBrowserReadSource(createLocalBrowserReadSource(store));
  const restoreCommands = installBrowserCommands({
    async dispatch(command) {
      commands.push(command);
      await Promise.resolve();
      return local.dispatch(command);
    },
  });
  t.after(() => {
    restoreCommands();
    restoreRead();
  });
  return { store, commands, spaceId: store.getState().settings.defaultSpaceId };
}
const nativeBytes = (command) => Buffer.byteLength(JSON.stringify({ kind: "command", command: JSON.stringify(command) }));

test("large tab imports await bounded batches and keep one ordered group without touching the window singleton", async (t) => {
  const { store, commands, spaceId } = setup(t),
    singleton = useBrowser.getState();
  store.getState().updateSettings({ newTabPosition: "top" });
  const tabs = Array.from({ length: 120 }, (_, i) => ({ url: `https://example.com/${i}`, title: `${i}:` + "x".repeat(3000), pinned: false }));
  assert.equal(await importTabs(spaceId, tabs, "Imported"), tabs.length);
  assert.ok(commands.filter((c) => c.method === "importTabs").length > 1);
  assert.ok(commands.every((c) => nativeBytes(c) < 1_048_576));
  assert.equal(Object.values(store.getState().groups).length, 1);
  const order = listIds(store.getState(), spaceListKey(store.getState(), spaceId))
    .map((id) => store.getState().tabs[id])
    .filter((tab) => tab.url.includes("example.com/"));
  assert.deepEqual(
    order.map((tab) => tab.url),
    tabs.map((tab) => tab.url),
  );
  assert.ok(order.every((tab) => tab.groupId === order[0].groupId));
  assert.strictEqual(useBrowser.getState(), singleton);
});

test("large bookmark exports preserve nested folder dates and destinations across bounded commands", async (t) => {
  const { store, commands, spaceId } = setup(t);
  const links = Array.from({ length: 120 }, (_, i) => ({ type: "url", title: "x".repeat(3000), url: `https://bookmarks.example/${i}`, dateAdded: 100 + i }));
  const root = {
    type: "folder",
    title: "Root",
    children: [{ type: "folder", title: "Toolbar", role: "toolbar", children: [{ type: "folder", title: "Kept", dateAdded: 42, children: links }] }],
  };
  assert.equal(await importBookmarks(spaceId, root, "Chrome"), links.length);
  assert.ok(commands.every((c) => nativeBytes(c) < 1_048_576));
  const kept = Object.values(store.getState().bookmarks.nodes).find((n) => n.title === "Kept");
  assert.equal(kept.addedAt, 42);
  assert.equal(kept.children.length, links.length);
  assert.deepEqual(
    kept.children.map((id) => store.getState().bookmarks.nodes[id].addedAt),
    links.map((n) => n.dateAdded),
  );
});

test("large Arc imports keep pinned folder order and nested empty folders", async (t) => {
  const { store, commands, spaceId } = setup(t);
  const links = Array.from({ length: 110 }, (_, i) => ({ type: "url", title: `Item ${i}:` + "x".repeat(3000), url: `https://arc.example/${i}` }));
  const pinned = [
    { type: "folder", title: "First empty", children: [] },
    { type: "folder", title: "Work", children: [...links, { type: "folder", title: "Nested empty", children: [] }] },
    { type: "folder", title: "Last empty", children: [] },
  ];
  const space = { id: "source", name: "Source", profileId: "Default", pinned, tabs: [] };
  assert.equal(await importArcSpace(spaceId, space), links.length);
  assert.ok(commands.every((c) => nativeBytes(c) < 1_048_576));
  const windowId = store.getState().windowOrder[0];
  const names = sidebarEntries(store.getState(), windowId, spaceId).pinned.map((e) =>
    e.startsWith("f:") ? store.getState().pinnedFolders[e.slice(2)].name : "tab",
  );
  assert.deepEqual(names, ["First empty", "Work", "Last empty"]);
  const work = Object.values(store.getState().pinnedFolders).find((f) => f.name === "Work");
  const contents = folderEntries(store.getState(), work.id);
  assert.equal(contents.length, links.length + 1);
  assert.equal(store.getState().pinnedFolders[contents.at(-1).slice(2)].name, "Nested empty");
});

test("native import destinations come from the active projection and reject private or removed spaces", (t) => {
  const { store, spaceId } = setup(t);
  store.setState((s) => ({ spaces: { ...s.spaces, [spaceId]: { ...s.spaces[spaceId], profileId: "native-profile" } } }));
  assert.equal(destinationProfile(spaceId), "native-profile");
  assert.throws(() => destinationProfile("incognito:window"), /unavailable/);
  assert.throws(() => destinationProfile("removed"), /unavailable/);
});
