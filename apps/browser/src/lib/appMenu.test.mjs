import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShortcut, platformOS } from "@bay/platform";

const { appMenuItems } = await import("./appMenu.ts");

const state = (patch = {}) => ({
  checked: [],
  disabled: [],
  titles: {},
  spaces: [],
  windows: [],
  bookmarkFolders: [],
  recentBookmarks: [],
  bookmarksBar: [],
  otherBookmarks: [],
  recentlyClosed: [],
  warnBeforeQuitting: false,
  ...patch,
});

const find = (items, id) => {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = item.children && find(item.children, id);

    if (inner) return inner;
  }
};

test("the menus come in macOS's order, with nested menus and each item's state", () => {
  const items = appMenuItems(state({ disabled: ["back"], checked: ["setAppearance:dark"], titles: { toggleMute: "Unmute Site" } }));
  assert.deepEqual(
    items.map((m) => m.title),
    ["Bay", "File", "Edit", "View", "Tabs", "Bookmarks", "History", "Extensions", "Window", "Help"],
  );
  assert.equal(find(items, "back").enabled, false);
  assert.equal(find(items, "forward").enabled, true);
  assert.equal(find(items, "setAppearance:dark").checked, true);
  assert.equal(find(items, "setAppearance:light").checked, undefined);
  assert.equal(find(items, "toggleMute").title, "Unmute Site");
  assert.ok(find(items, "menu:Edit:Find").children.some((item) => item.id === "findInPage"));
});

test("each item shows its current shortcut, chosen ones included", () => {
  const items = appMenuItems(state(), { openLibrary: ["l", "option", "command"] });
  assert.equal(find(items, "newTab").shortcut, formatShortcut({ key: "T", mod: true }, platformOS));
  assert.equal(find(items, "openLibrary").shortcut, formatShortcut({ key: "l", mod: true, alt: true }, platformOS));
  assert.equal(find(items, "share").shortcut, undefined);
});

test("bookmarks, recently closed and spaces fill their menus", () => {
  const items = appMenuItems(
    state({
      bookmarksBar: [
        { id: "b1", title: "Docs", url: "https://docs" },
        { id: "f1", title: "Work", children: [{ id: "b2", title: "", url: "https://work" }] },
      ],
      recentlyClosed: [{ id: "c1", title: "Old Tab" }],
      spaces: [{ id: "s1", title: "Home", current: true }],
    }),
  );

  assert.equal(find(items, "openBookmark:b1").title, "Docs");
  assert.equal(find(items, "openBookmark:b2").title, "https://work");
  assert.equal(find(items, "restoreClosed:c1").title, "Old Tab");
  assert.equal(find(items, "switchSpace:s1").checked, true);
});

test("the Window and Extensions menus list what's open and installed", () => {
  const items = appMenuItems(
    state({
      windows: [{ id: "w2", title: "Work" }],
      extensions: [
        { id: "e1", title: "Blocker", enabled: true },
        { id: "e2", title: "Off", enabled: false },
      ],
    }),
  );

  assert.equal(find(items, "focusWindow:w2").title, "Work");
  assert.equal(find(items, "openExtension:e1").enabled, true);
  assert.equal(find(items, "openExtension:e2").enabled, false);
  assert.equal(find(items, "manageExtensions").title, "Manage Extensions…");
  assert.equal(find(appMenuItems(state()), "addExtension").title, "Add Extension…");
});
