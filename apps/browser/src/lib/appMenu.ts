// The app menu on the Chrome-hosted desktop, which has no menu bar: F10 opens macOS's menus (Menus.swift) in the
// window, from the same action list Settings › Shortcuts shows, with the state the menu bar would have (shellBridge's
// menuState) and each item's current shortcut.

import { formatShortcut, platformOS } from "@bay/platform";
import { showMenu, type MenuBookmark, type MenuItem, type MenuState } from "@bay/desktop";
import { keyBindings, type ShortcutOverrides } from "./keyBindings";
import { SHORTCUT_ACTIONS } from "./shortcutCatalog";

const MENUS = ["Bay", "File", "Edit", "View", "Tabs", "Bookmarks", "History", "Extensions", "Window", "Help"];

// Under the window's top edge, where a menu bar's first menu would open.
const MENU_ANCHOR: [number, number] = [8, 8];

type Submenu = Extract<MenuItem, { id: string }>;

const bookmarkItems = (nodes: MenuBookmark[]): MenuItem[] =>
  nodes.map((node) =>
    node.children
      ? { id: `folder:${node.id}`, title: node.title, children: bookmarkItems(node.children) }
      : { id: `openBookmark:${node.id}`, title: node.title || node.url || "Untitled" },
  );

/** The menus, in macOS's order: each action with its state, plus the lists only the menu bar shows. */
export function appMenuItems(state: MenuState, overrides: ShortcutOverrides = {}): MenuItem[] {
  const shortcuts = new Map<string, string>();

  for (const { command, arg, stroke } of keyBindings(overrides)) {
    const id = arg ? `${command}:${arg}` : command;

    if (command && !shortcuts.has(id)) shortcuts.set(id, formatShortcut(stroke, platformOS));
  }

  const menus = new Map<string, Submenu>(MENUS.map((title) => [title, { id: `menu:${title}`, title, children: [] }]));

  const submenuOf = (path: string[]): Submenu => {
    let menu = menus.get(path[0]!)!;

    for (const title of path.slice(1)) {
      let child = menu.children!.find((item): item is Submenu => "id" in item && item.id === `menu:${path[0]}:${title}`);

      if (!child) menu.children!.push((child = { id: `menu:${path[0]}:${title}`, title, children: [] }));
      menu = child;
    }

    return menu;
  };

  for (const { id, title, path } of SHORTCUT_ACTIONS) {
    const command = id.split(":")[0]!;
    submenuOf(path).children!.push({
      id,
      title: state.titles[id] ?? title,
      enabled: !state.disabled.includes(id) && !state.disabled.includes(command),
      ...(state.checked.includes(id) ? { checked: true } : undefined),
      ...(shortcuts.has(id) ? { shortcut: shortcuts.get(id) } : undefined),
    });
  }

  const bookmarks = [
    ...state.bookmarksBar,
    ...(state.otherBookmarks.length ? [{ id: "other", title: "Other Bookmarks", children: state.otherBookmarks }] : []),
  ];

  if (bookmarks.length) menus.get("Bookmarks")!.children!.push({ separator: true }, ...bookmarkItems(bookmarks));
  const closed = [...state.recentlyClosed, ...(state.recentlyClosedGroups ?? [])];

  if (closed.length)
    menus.get("History")!.children!.push({
      id: "menu:History:Recently Closed",
      title: "Recently Closed",
      children: closed.map((entry) => ({ id: `restoreClosed:${entry.id}`, title: entry.title })),
    });
  const extensions = state.extensions ?? [];
  menus
    .get("Extensions")!
    .children!.push(
      ...extensions.map((extension) => ({ id: `openExtension:${extension.id}`, title: extension.title, enabled: extension.enabled })),
      ...(extensions.length ? [{ separator: true as const }] : []),
      { id: "addExtension", title: "Add Extension…" },
      { id: "manageExtensions", title: "Manage Extensions…" },
    );

  if (state.windows.length) {
    menus.get("Window")!.children!.push({ separator: true }, ...state.windows.map((window) => ({ id: `focusWindow:${window.id}`, title: window.title })));
  }

  if (state.spaces.length)
    menus.get("Window")!.children!.push({
      id: "menu:Window:Spaces",
      title: "Spaces",
      children: state.spaces.map((space) => ({ id: `switchSpace:${space.id}`, title: space.title, ...(space.current ? { checked: true } : undefined) })),
    });

  return [...menus.values()].filter((menu) => menu.children!.length);
}

/** Opens the menu and runs what was chosen, as the menu bar's command would. */
export async function showAppMenu(state: MenuState, overrides: ShortcutOverrides, run: (command: string, arg: string | null) => void) {
  const choice = await showMenu(appMenuItems(state, overrides), MENU_ANCHOR);

  if (!choice || choice.startsWith("menu:") || choice.startsWith("folder:")) return;
  const split = choice.indexOf(":");
  run(split < 0 ? choice : choice.slice(0, split), split < 0 ? null : choice.slice(split + 1));
}
