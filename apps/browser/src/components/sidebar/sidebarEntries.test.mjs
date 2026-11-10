import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../../store/browserStore.ts";
import { live, setLive } from "../../activity/activityStore.ts";
import * as entries from "./sidebarEntries.ts";

const S = () => useBrowser.getState();

function fixture() {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom" });
  setLive({ folders: {}, folderOrder: [], items: {}, completing: {}, expandedStacks: {}, showAll: {} });
  const w = S().createWindow({ url: "https://page.example" });
  const page = S().windows[w].activeTabIds.default;
  const add = (name) => S().newTab(w, { url: `https://${name}.example`, background: true });
  const favorite = add("favorite");
  S().pinTabs([favorite], true);
  const leaf = add("leaf");
  const root = S().newPinnedFolder(w, { name: "Root" });
  const child = S().newPinnedFolder(w, { name: "Child", parentId: root, tabIds: [leaf] });
  const empty = S().newPinnedFolder(w, { name: "Empty", beforeId: root });

  const a = add("a"),
    b = add("b");

  const group = S().createGroup([a, b]);

  const c = add("c"),
    d = add("d");

  const split = S().createSplit([c, d]);
  const second = S().createWindow({ url: "https://second.example" });
  S().activate(page, w);

  return { w, page, favorite, leaf, root, child, empty, a, b, group, c, d, split, second };
}

function select(s, f, api = entries, activity = live()) {
  return {
    main: api.sidebarEntries(s, f.w),
    group: api.groupEntries(s, f.group),
    root: api.folderEntries(s, f.root),
    child: api.folderEntries(s, f.child),
    rows: api.sidebarKeyboardRows(s, f.w, activity),
  };
}

let check = 0;

// A separate module starts with empty selector caches. Compare the warm selectors to a fresh computation,
// without duplicating their dependency fields or entry-building logic in the test.
async function assertFresh(s, f, activity = live()) {
  const fresh = await import(`./sidebarEntries.ts?fresh=${++check}`);
  const actual = select(s, f, entries, activity);
  assert.deepEqual(actual, select(s, f, fresh, activity));

  return actual;
}

test("real metadata updates reuse entries and keyboard rows without scanning tabs or lists", () => {
  const f = fixture();

  let reads = 0,
    enumerations = 0;

  const sentinel = new Proxy(S().tabs[f.leaf], {
    get(target, key) {
      if (key === "spaceId" || key === "pinnedRow") reads++;

      // Fixture tab object has no getters; indexing forwards the stored properties.
      return target[key];
    },
  });

  const tabs = new Proxy(
    { ...S().tabs, [f.leaf]: sentinel },
    {
      ownKeys(target) {
        enumerations++;

        return Reflect.ownKeys(target);
      },
    },
  );

  useBrowser.setState({ tabs });
  const before = select(S(), f);

  for (const patch of [
    { title: "New title" },
    { favicon: "new-icon" },
    { lastActiveAt: 42 },
    { customTitle: "Custom title", customIcon: "star" },
    { navigation: { url: "https://next.example", seq: 42 }, unloaded: true },
  ]) {
    S().updateTab(f.page, patch);
    reads = enumerations = 0;
    const after = select(S(), f);

    for (const key of Object.keys(before)) assert.strictEqual(after[key], before[key], `${key} after ${Object.keys(patch)}`);
    assert.equal(reads, 0, "unchanged folder members must not be scanned again");
    assert.equal(enumerations, 0, "known updateTab deltas must not enumerate the prior tabs map");
  }

  for (const windowId of [f.w, f.second]) {
    S().setWindowFrame(windowId, [5, 10, 1200, 800]);
    reads = 0;
    const after = select(S(), f);

    for (const key of Object.keys(before)) assert.strictEqual(after[key], before[key], `${key} after window frame`);
    assert.equal(reads, 0);
  }
});

test("activation skips entry rebuilding while keyboard disclosure and numbered split panes stay current", () => {
  const f = fixture();
  S().updatePinnedFolder(f.root, { collapsed: true });
  S().updateGroup(f.group, { collapsed: true });
  const before = select(S(), f);
  S().activate(f.leaf, f.w);
  const leaf = select(S(), f);

  for (const key of ["main", "group", "root", "child"]) assert.strictEqual(leaf[key], before[key]);
  assert.ok(leaf.rows.some((row) => row.id === `t:${f.leaf}` && row.parentId === `f:${f.root}`));
  S().activate(f.a, f.w);
  const group = select(S(), f);
  assert.ok(group.rows.some((row) => row.id === `t:${f.a}` && row.parentId === `g:${f.group}`));
  assert.ok(!group.rows.some((row) => row.id === `t:${f.leaf}`));
  S().activate(f.c, f.w);
  assert.ok(entries.numberedTabs(S(), f.w).includes(f.c));
  S().activate(f.d, f.w);
  assert.ok(entries.numberedTabs(S(), f.w).includes(f.d));
  assert.ok(!entries.numberedTabs(S(), f.w).includes(f.c));
});

test("warm caches preserve structural tab dependencies for arbitrary and back-and-forth snapshots", async () => {
  const f = fixture();
  const state = S();

  const patches = [
    [f.page, { pinned: true }],
    [f.page, { pinnedRow: true }],
    [f.leaf, { folderId: f.root }],
    [f.leaf, { pinnedRow: false }],
    [f.favorite, { spaceId: "other" }],
    [f.c, { pinned: true }],
    [f.c, { pinnedRow: true, folderId: f.root }],
    [f.page, { liveItem: { folderId: "feed", itemId: "one" } }],
  ];

  for (const [id, patch] of patches) {
    select(state, f);
    const next = { ...state, tabs: { ...state.tabs, [id]: { ...state.tabs[id], ...patch } } };
    await assertFresh(next, f);
    await assertFresh(state, f);
    // A metadata-only update after the structural read must not reuse the other snapshot's result.
    const titled = { ...next, tabs: { ...next.tabs, [id]: { ...next.tabs[id], title: "Updated" } } };
    await assertFresh(titled, f);
    await assertFresh(state, f);
  }

  for (const id of [f.page, f.leaf, f.c]) {
    const tabs = { ...state.tabs };
    delete tabs[id];
    await assertFresh({ ...state, tabs }, f);
    await assertFresh(state, f);
  }

  // An added tab already referenced by an arbitrary list must invalidate existence-dependent caches.
  const missing = { ...state, tabLists: { ...state.tabLists, default: [...state.tabLists.default, "added"] } };
  select(missing, f);
  const added = { ...missing, tabs: { ...missing.tabs, added: { ...state.tabs[f.page], id: "added" } } };
  const result = await assertFresh(added, f);
  assert.ok(result.main.list.includes("t:added"));
  await assertFresh(missing, f);
});

test("real pin, folder, group, split, move and hydrate actions retain fresh structure", async () => {
  const f = fixture();
  const saved = S();
  select(saved, f);

  const actions = [
    () => S().pinTabs([f.page], true),
    () => S().pinTabs([f.page], false),
    () => S().pinRows([f.page], true),
    () => S().newPinnedFolder(f.w, { name: "Moved", tabIds: [f.page] }),
    () => S().movePinnedFolder(f.child, null, null),
    () => S().moveTab(f.leaf, 0),
    () => S().removeTabsFromGroup([f.b]),
    () => S().addTabsToGroup(f.group, [f.b]),
    () => S().updateGroup(f.group, { pinned: true, collapsed: true }),
    () => S().pinRows([f.c], true),
    () => S().pinTabs([f.c], true),
    () => S().separateSplit(f.split),
    () => S().removeTab(f.b),
    () => S().createSpace({ name: "Other" }),
    () => S().moveTabToSpace(f.leaf, S().spaceOrder.at(-1), f.w),
    () => S().switchSpace(f.w, S().spaceOrder.at(-1)),
    () => S().hydrate(saved),
  ];

  for (const action of actions) {
    action();
    await assertFresh(S(), f);
  }

  // A real complete replacement has no known delta, even with reused window and group identities.
  useBrowser.setState({ ...saved, tabs: { ...saved.tabs, [f.favorite]: { ...saved.tabs[f.favorite], pinned: false } } }, true);
  assert.ok(!(await assertFresh(S(), f)).main.tiles.includes(f.favorite));
  await assertFresh(saved, f);
});

test("window identity, kind, shown space, privacy and other window kinds remain dependencies", async () => {
  const f = fixture();
  const state = S();

  const activity = {
    ...live(),
    folders: { feed: { id: "feed", kind: "documents", spaceId: "default", collapsed: false } },
    folderOrder: ["feed"],
    items: { feed: [{ id: "one", title: "One", url: "https://one.example", source: "drive" }] },
  };

  const small = { ...state.windows[f.w], kind: "small" };

  for (const windows of [
    {},
    { ...state.windows, [f.w]: { ...state.windows[f.w], spaceId: "other" } },
    { ...state.windows, [f.w]: small },
    { ...state.windows, [f.w]: { ...small, id: "other-list" } },
    { ...state.windows, [f.w]: { ...state.windows[f.w], incognito: true } },
    { ...state.windows, [f.second]: { ...state.windows[f.second], kind: "small" } },
  ]) {
    select(state, f, entries, activity);
    const next = { ...state, windows, tabLists: { ...state.tabLists, [f.w]: [f.page], "other-list": [f.favorite] } };
    await assertFresh(next, f, activity);
    await assertFresh(state, f, activity);
    assert.deepEqual(entries.sidebarEntries(next, f.w, "default"), (await import(`./sidebarEntries.ts?fresh=${++check}`)).sidebarEntries(next, f.w, "default"));
  }

  // activeTabId consults the active tab's owning window kind, including windows other than this selector's.
  const elsewhere = { ...state, tabs: { ...state.tabs, [f.page]: { ...state.tabs[f.page], windowId: f.second } } };
  select(elsewhere, f);
  await assertFresh({ ...elsewhere, windows: { ...elsewhere.windows, [f.second]: { ...elsewhere.windows[f.second], kind: "small" } } }, f);
});

test("live item membership changes invalidate rows even when the main entry IDs stay equal", async () => {
  const f = fixture();
  const item = (id) => ({ id, title: id, url: `https://${id}.example`, source: "drive" });

  const activity = {
    ...live(),
    folders: {
      one: { id: "one", kind: "documents", spaceId: "default", collapsed: true },
      two: { id: "two", kind: "documents", spaceId: "default", collapsed: false },
    },
    folderOrder: ["one", "two"],
    items: { one: [item("a"), item("b")], two: [item("a")] },
  };

  for (const liveItem of [{ folderId: "one", itemId: "a" }, { folderId: "one", itemId: "b" }, { folderId: "two", itemId: "a" }, undefined]) {
    S().updateTab(f.page, { liveItem });
    const result = await assertFresh(S(), f, activity);

    if (liveItem?.folderId === "one") assert.ok(result.rows.some((row) => row.id === `live|one|${liveItem.itemId}` && row.tabIds.includes(f.page)));

    if (!liveItem) assert.ok(result.main.list.includes(`t:${f.page}`));
  }
});
