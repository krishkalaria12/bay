import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { DEFAULT_SETTINGS } = await import("../../store/settings.ts");
const { activeTabId } = await import("../../store/model.ts");
const { setLive, live } = await import("../../live/store.ts");
const { sidebarKeyboardRows } = await import("./entries.ts");
const { adjacentKeyboardRow, reconcileKeyboardRow } = await import("./keyboardModel.ts");
const { sidebarUi, setSidebarUi } = await import("./state.ts");
const keyboard = await import("./keyboard.ts");
const { sidebarKeyboardCalls } = await import("../../test-native-stub.mjs");
const S = () => useBrowser.getState();
DEFAULT_SETTINGS.newTabPosition = "bottom";

function fixture() {
  S().hydrate({});
  setSidebarUi({ keyboard: {}, renaming: null });
  setLive({ folders: {}, folderOrder: [], items: {}, showAll: {}, expandedStacks: {}, completing: {} });
  const w = S().createWindow({ url: "https://page.example" });
  const page = activeTabId(S(), w);
  const add = (name) => S().newTab(w, { url: `https://${name}.example`, background: true });
  const favorite = add("favorite");
  S().pinTabs([favorite], true);
  const pinned = add("pinned");
  S().pinRows([pinned], true);
  const leaf = add("leaf");
  const root = S().newPinnedFolder(w, { name: "Work" });
  const child = S().newPinnedFolder(w, { name: "Child", parentId: root, tabIds: [leaf] });
  const a = add("a"),
    b = add("b");
  const group = S().groupTabs([a, b], { name: "Group", pinned: true });
  const c = add("c"),
    d = add("d");
  const split = S().createSplit([c, d]);
  S().activate(page, w);
  return { w, page, favorite, pinned, leaf, root, child, group, a, b, split, c, d };
}
const ids = (w) => sidebarKeyboardRows(S(), w).map((row) => row.id);
const focusId = (w) => sidebarUi().keyboard[w]?.rowId;
const moveTo = (w, id) => {
  keyboard.focusSidebar(w);
  keyboard.runSidebarKey(w, "Home");
  for (let i = 0; i < 150 && focusId(w) !== id; i++) keyboard.runSidebarKey(w, "ArrowDown");
  assert.equal(focusId(w), id);
};

test("visible order covers favorites, pinned rows, nested folders, pinned groups and splits once", () => {
  const f = fixture();
  const rows = sidebarKeyboardRows(S(), f.w);
  assert.deepEqual(
    rows.slice(0, 8).map((r) => r.id),
    [`t:${f.favorite}`, `t:${f.pinned}`, `f:${f.root}`, `f:${f.child}`, `t:${f.leaf}`, `g:${f.group}`, `t:${f.a}`, `t:${f.b}`],
  );
  assert.ok(rows.some((r) => r.id === `s:${f.split}` && r.tabIds.includes(f.c) && r.tabIds.includes(f.d)));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});

test("collapsed ancestors expose only their header and active leaf, bypassing hidden child headers", () => {
  const f = fixture();
  S().activate(f.leaf, f.w);
  S().updatePinnedFolder(f.root, { collapsed: true });
  assert.ok(ids(f.w).includes(`t:${f.leaf}`));
  assert.ok(!ids(f.w).includes(`f:${f.child}`));
  assert.equal(sidebarKeyboardRows(S(), f.w).find((r) => r.id === `t:${f.leaf}`).parentId, `f:${f.root}`);
  S().activate(f.page, f.w);
  assert.ok(!ids(f.w).includes(`t:${f.leaf}`));
  S().updateGroup(f.group, { collapsed: true });
  assert.ok(!ids(f.w).includes(`t:${f.a}`));
  S().activate(f.b, f.w);
  assert.ok(ids(f.w).includes(`t:${f.b}`));
  assert.ok(!ids(f.w).includes(`t:${f.a}`));
});

test("folded pinned section hides its folders and groups, retaining favorites and ordinary tabs", () => {
  const f = fixture();
  S().updateSpace("default", { folded: true });
  const rows = ids(f.w);
  assert.ok(rows.includes(`t:${f.favorite}`) && rows.includes(`t:${f.page}`));
  for (const id of [`t:${f.pinned}`, `f:${f.root}`, `g:${f.group}`]) assert.ok(!rows.includes(id));
});

test("focus starts on active leaf; arrows and hierarchy never activate or change multi-selection", () => {
  const f = fixture();
  S().activate(f.leaf, f.w);
  S().setSelection(f.w, [f.page, f.pinned]);
  keyboard.focusSidebar(f.w);
  assert.equal(focusId(f.w), `t:${f.leaf}`);
  keyboard.runSidebarKey(f.w, "ArrowLeft");
  assert.equal(focusId(f.w), `f:${f.child}`);
  keyboard.runSidebarKey(f.w, "ArrowLeft");
  assert.equal(S().pinnedFolders[f.child].collapsed, true);
  keyboard.runSidebarKey(f.w, "ArrowLeft");
  assert.equal(focusId(f.w), `f:${f.root}`);
  keyboard.runSidebarKey(f.w, "ArrowRight");
  assert.equal(focusId(f.w), `f:${f.child}`);
  keyboard.runSidebarKey(f.w, "ArrowRight");
  assert.equal(S().pinnedFolders[f.child].collapsed, false);
  assert.equal(activeTabId(S(), f.w), f.leaf);
  assert.deepEqual(S().selection[f.w], [f.page, f.pinned]);
});

test("native keyboard command effects target the focused row, and Escape disables capture", () => {
  const f = fixture();
  const calls = [];
  const unreg = keyboard.registerSidebarKeyboardActions(
    f.w,
    Object.fromEntries(["open", "peek", "close", "rename", "focusPage"].map((name) => [name, (row) => calls.push([name, row?.id])])),
    () => {},
  );
  moveTo(f.w, `t:${f.pinned}`);
  for (const key of ["Enter", "Space", "Backspace"]) keyboard.runSidebarKey(f.w, key);
  assert.equal(keyboard.renameKeyboardRow(f.w), true);
  assert.deepEqual(
    calls.slice(0, 4),
    ["open", "peek", "close", "rename"].map((name) => [name, `t:${f.pinned}`]),
  );
  keyboard.runSidebarKey(f.w, "Escape");
  assert.equal(sidebarUi().keyboard[f.w].active, false);
  assert.deepEqual(sidebarKeyboardCalls.at(-1), { windowId: f.w, active: false });
  assert.equal(calls.at(-1)[0], "focusPage");
  keyboard.runSidebarKey(f.w, "Backspace");
  assert.equal(calls.length, 5, "page/editor keystrokes are ignored outside sidebar capture");
  assert.equal(keyboard.renameKeyboardRow(f.w), false);
  unreg();
});

test("Return discloses folders and groups and focus recovers after collapse and deletion", () => {
  const f = fixture();
  moveTo(f.w, `f:${f.child}`);
  keyboard.runSidebarKey(f.w, "Enter");
  assert.equal(S().pinnedFolders[f.child].collapsed, true);
  keyboard.runSidebarKey(f.w, "Enter");
  assert.equal(S().pinnedFolders[f.child].collapsed, false);
  keyboard.runSidebarKey(f.w, "ArrowRight");
  assert.equal(focusId(f.w), `t:${f.leaf}`);
  S().updatePinnedFolder(f.root, { collapsed: true });
  keyboard.reconcileSidebarKeyboard(f.w);
  assert.equal(focusId(f.w), `f:${f.root}`);
  moveTo(f.w, `t:${f.page}`);
  S().closeTab(f.page);
  keyboard.reconcileSidebarKeyboard(f.w);
  assert.ok(ids(f.w).includes(focusId(f.w)));
});

test("focus is isolated per window and a hidden/top sidebar is revealed by Command-period", () => {
  const f = fixture();
  const second = S().createWindow({ spaceId: "default" });
  S().toggleSidebar(f.w);
  S().toggleTabLayout(f.w);
  keyboard.focusSidebar(f.w);
  assert.equal(S().windows[f.w].sidebarOpen, true);
  assert.equal(S().windows[f.w].tabLayout, "sidebar");
  keyboard.runSidebarKey(f.w, "Home");
  keyboard.focusSidebar(second);
  const before = focusId(second);
  keyboard.runSidebarKey(f.w, "End");
  assert.equal(focusId(second), before);
});

test("live folders, stacks, active kept items, strays and show-more rows match rendering", () => {
  const f = fixture();
  const item = (id) => ({ id, title: id, url: `https://${id}.example`, source: "github", section: "authored" });
  const items = Array.from({ length: 15 }, (_, i) => item(`item${i}`));
  items[0].pr = { repo: "org/repo", stack: { id: "stack1", position: 1 } };
  items[1].pr = { repo: "org/repo", stack: { id: "stack1", position: 2 } };
  setLive({
    folders: { lf: { id: "lf", spaceId: "default", name: "Live", kind: "pullRequests", collapsed: false } },
    folderOrder: ["lf"],
    items: { lf: items },
    expandedStacks: { stack1: false },
  });
  let rows = sidebarKeyboardRows(S(), f.w);
  assert.ok(rows.some((r) => r.id === "stack|lf|stack1"));
  assert.ok(!rows.some((r) => r.id === "live|lf|item0"));
  assert.ok(rows.some((r) => r.id === "more|lf|authored"));
  moveTo(f.w, "stack|lf|stack1");
  keyboard.runSidebarKey(f.w, "ArrowRight");
  assert.ok(ids(f.w).includes("live|lf|item0"));
  moveTo(f.w, "more|lf|authored");
  keyboard.runSidebarKey(f.w, "Enter");
  assert.ok(ids(f.w).includes("live|lf|item14"));
  assert.ok(!ids(f.w).includes("more|lf|authored"));
  const stray = S().newTab(f.w, { url: "https://stray.example", background: true });
  S().updateTab(stray, { liveItem: { folderId: "lf", itemId: "gone" } });
  assert.equal(sidebarKeyboardRows(S(), f.w).find((r) => r.id === `t:${stray}`).parentId, "livefolder|lf");
  setLive({ folders: { ...live().folders, lf: { ...live().folders.lf, collapsed: true } } });
  assert.ok(!ids(f.w).includes(`t:${stray}`));
  S().activate(stray, f.w);
  assert.ok(ids(f.w).includes(`t:${stray}`));
});

test("private windows never expose live folders", () => {
  fixture();
  setLive({ folders: { lf: { id: "lf", spaceId: "default", kind: "documents" } }, folderOrder: ["lf"] });
  const w = S().createWindow({ incognito: true });
  assert.ok(!sidebarKeyboardRows(S(), w).some((r) => r.kind === "liveFolder"));
});

test("extension rows participate in hierarchy and actions and unregister without stale targets", () => {
  const f = fixture();
  const calls = [];
  const rows = [
    { id: "local:root", kind: "local", tabIds: [], collapsed: true, expand: (closed) => calls.push(["expand", closed]), rename: () => calls.push(["rename"]) },
    {
      id: "local:child",
      kind: "local",
      parentId: "local:root",
      tabIds: [],
      open: () => calls.push(["open"]),
      peek: () => calls.push(["peek"]),
      close: () => calls.push(["close"]),
    },
  ];
  const off = keyboard.registerSidebarKeyboardRows(f.w, "default", "files", rows);
  keyboard.focusSidebar(f.w);
  keyboard.runSidebarKey(f.w, "Home");
  while (focusId(f.w) !== "local:root") keyboard.runSidebarKey(f.w, "ArrowDown");
  keyboard.runSidebarKey(f.w, "ArrowRight");
  keyboard.renameKeyboardRow(f.w);
  keyboard.runSidebarKey(f.w, "ArrowDown");
  for (const key of ["Enter", "Space", "Backspace"]) keyboard.runSidebarKey(f.w, key);
  assert.deepEqual(calls, [["expand", false], ["rename"], ["open"], ["peek"], ["close"]]);
  off();
  assert.ok(!keyboard.keyboardRows(f.w).some((r) => r.id.startsWith("local:")));
});

test("empty lists, end boundaries and missing targets reconcile deterministically", () => {
  const rows = [
    { id: "parent", kind: "folder", tabIds: [] },
    { id: "child", parentId: "parent", kind: "tab", tabIds: [] },
    { id: "last", kind: "tab", tabIds: [] },
  ];
  assert.equal(adjacentKeyboardRow(rows, "parent", -1).id, "parent");
  assert.equal(adjacentKeyboardRow(rows, "last", 1).id, "last");
  assert.equal(adjacentKeyboardRow([], undefined, 1), undefined);
  assert.equal(reconcileKeyboardRow([rows[0], rows[2]], "child", rows).id, "parent");
  assert.equal(reconcileKeyboardRow([rows[0], rows[2]], "last", rows).id, "last");
  assert.equal(reconcileKeyboardRow([], "last", rows), undefined);
});
