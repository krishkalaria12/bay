import { capabilities } from "@bay/platform";
import { showMenu, type MenuItem } from "@bay/shell";
import { closeTab, moveTabToSpace, moveTabToWindow, openWindow, switchToTab, toggleMute } from "../../lib/actions";
import { withFolderMoveUndo } from "../../lib/folderUndo";
import { normalizeAwakeSite, siteKeptAwake } from "../../lib/awakeSites";
import { sleepTab, useLifecycle } from "../../lib/tabLifecycle";
import { webviews } from "../../lib/webviews";
import { folderChildren } from "../../store/bookmarks";
import { reportBrowserCommand } from "../../runtime/commands";
import {
  cleanUpTabs,
  closeGroup,
  deleteGroup,
  deletePinnedFolder,
  duplicateGroup,
  moveGroup,
  moveGroupToBookmarksBar,
  movePinnedFolder,
  pinRows,
  pinTabs,
  placeTabs,
  removeTabsFromGroup,
  restoreCleaned,
  returnToPinnedUrl,
  setPinnedUrl,
  setSelection,
  ungroup,
  updateGroup,
  updatePinnedFolder,
} from "../../runtime/organizeActions";
import { updateSettings } from "../../runtime/settingsActions";
import { removeTabFromSplit } from "../../runtime/splitActions";
import { closeTabs, duplicateTab, togglePin } from "../../runtime/tabActions";
import { moveTabsToWindow, restoreClosed } from "../../runtime/windowActions";
import { useBrowser } from "../../store/browser";
import { browserRead } from "../../store/read";
import {
  activeTabId,
  bookmarkSpaceId,
  inPinnedContainer,
  isIncognitoSpace,
  listIds,
  pinnedPage,
  plural,
  spaceListKey,
  tabLabel,
  viewTabIds,
  windowTitle,
} from "../../store/model";
import { awayFromPin, cleanedTabsFor, groupLabel, groupOf, keptDeletedGroups, selectedTabIds } from "../../store/organize";
import { splitOf } from "../../store/splits";
import type { GroupColor, Tab } from "../../store/types";
import {
  allMuted,
  bookmarkTabs,
  copyUrls,
  editPinnedPage,
  muteAll,
  newGroupWithSelection,
  newPinnedFolderWith,
  openIconPicker,
  startRename,
  tabTitle,
} from "./actions";
import { isCalendarUrl } from "../../live/meetings";
import { bookmarkTab } from "../bookmarks/actions";
import { setPopover } from "../layout/pageState";
import { openInSplit } from "../layout/splitActions";
import { calendarMenuItem, newLiveFolderMenuItem, runCalendarMenu, runNewLiveFolder } from "./liveMenus";
import { openSyncedTab, syncedDevicesMenuItem } from "../../sync/menu";
import { setSidebarUi } from "./state";
import { GROUP_COLORS, nearestGroupColor } from "./tokens";
import { canMoveFolder, childFolderIds, folderDepth, folderTabIds, MAX_FOLDER_DEPTH } from "../../store/folders";

const store = () => browserRead.getState();
const sep = { separator: true } as const;
type Mods = NonNullable<Extract<MenuItem, { id: string }>["modifiers"]>;
const hint = (key: string, ...modifiers: Mods) => ({ key, modifiers });

function bookmarkFolderItems(windowId: string, prefix: string): MenuItem[] {
  const s = store();
  const roots = s.bookmarks.roots[bookmarkSpaceId(s, s.windows[windowId])];
  const folders = roots ? [...folderChildren(s.bookmarks, roots.bar), ...folderChildren(s.bookmarks, roots.other)].filter((n) => n.kind === "folder") : [];
  return [
    { id: `${prefix}bar`, title: "Bookmarks Bar", symbol: "menubar.rectangle" },
    ...(roots ? [{ id: `${prefix}${roots.other}`, title: "Other Bookmarks", symbol: "folder" }] : []),
    ...folders.map((f) => ({ id: `${prefix}${f.id}`, title: f.title, symbol: "folder" })),
    sep,
    { id: `${prefix}new`, title: "New Folder…", symbol: "folder.badge.plus" },
  ];
}

function moveToWindowItems(windowId: string): MenuItem[] {
  const s = store();
  const others = s.windowOrder.filter((id) => id !== windowId && !s.windows[id]!.incognito && s.windows[id]!.kind !== "small");
  return [
    ...others.map((id) => ({ id: `window:${id}`, title: windowTitle(s, id) })),
    ...(others.length ? [sep] : []),
    { id: "window:new", title: "New Window" },
  ];
}

function moveToGroupItems(windowId: string, exclude: string | undefined): MenuItem[] {
  const s = store();
  const w = s.windows[windowId];
  const groups = Object.values(s.groups).filter((g) => g.spaceId === w?.spaceId && g.id !== exclude);
  return groups.map((g) => ({ id: `group:${g.id}`, title: groupLabel(s, g), symbol: g.pinned ? "pin" : "square.on.square" }));
}

// Branches have their own destination as well as their children.
export function moveToFolderItems(windowId: string, exclude: string | undefined, movingFolder = false): MenuItem[] {
  const s = store();
  const spaceId = s.windows[windowId]?.spaceId;
  const branch = (parentId: string | null, depth: number): MenuItem[] =>
    childFolderIds(s, parentId, spaceId).flatMap((id): MenuItem[] => {
      if (depth > MAX_FOLDER_DEPTH || (movingFolder && !canMoveFolder(s, exclude!, id))) return [];
      const f = s.pinnedFolders[id]!;
      const children = branch(id, depth + 1);
      const item: MenuItem = { id: `pfolder:${id}`, title: f.name || "New Folder", symbol: "folder", enabled: id !== exclude };
      return children.length
        ? [
            {
              id: `pfolderBranch:${id}`,
              title: f.name || "New Folder",
              symbol: "folder",
              children: [{ ...item, title: "Move Here" }, sep, ...children],
            },
          ]
        : [item];
    });
  const folders = branch(null, 1);
  return [...folders, ...(folders.length ? [sep] : []), ...(!movingFolder ? [{ id: "pfolder:new", title: "New Folder", symbol: "folder.badge.plus" }] : [])];
}

function runFolderChoice(windowId: string, ids: string[], choice: string): boolean {
  if (!choice.startsWith("pfolder:")) return false;
  const folderId = choice.slice(8);
  if (folderId === "new") reportBrowserCommand(newPinnedFolderWith(windowId, ids));
  else withFolderMoveUndo(windowId, () => placeTabs(ids, { pinned: false, row: true, folderId }));
  return true;
}

/** The tabs a tab's Close Tabs Above, Below and Others close: its section's, never a pinned one. */
export function tabsAround(windowId: string, tab: Tab) {
  const s = store();
  const list = viewTabIds(s, windowId).filter((id) => !pinnedPage(s.tabs[id]!));
  const index = list.indexOf(tab.id);
  return {
    above: pinnedPage(tab) ? [] : list.slice(0, index),
    below: pinnedPage(tab) ? [] : list.slice(index + 1),
    others: list.filter((id) => id !== tab.id),
  };
}

// yab's tab menu, in its order (Bay's own items after it, before the closing ones).
export async function openTabMenu(windowId: string, tab: Tab) {
  const s = store();
  const selected = selectedTabIds(s, windowId);
  if (selected.length > 1 && selected.includes(tab.id)) return openMultiMenu(windowId, selected);
  if (s.selection[windowId]?.length) reportBrowserCommand(setSelection(windowId, []));

  const { above, below, others } = tabsAround(windowId, tab);
  const group = groupOf(s, tab.id);
  const split = splitOf(s, tab.id);
  const incognito = isIncognitoSpace(tab.spaceId);
  const across = (s.windows[windowId]?.tabLayout ?? s.settings.tabLayout) === "top";
  const away = awayFromPin(tab);
  const active = activeTabId(s, windowId);
  const current = tab.id === active;
  const moveToSpace: MenuItem[] = [
    ...s.spaceOrder.map((id) => ({ id: `profile:${id}`, title: s.spaces[id]!.name, checked: id === tab.spaceId, enabled: id !== tab.spaceId })),
    sep,
    { id: "profile:new", title: "New Space…" },
  ];
  const groups = moveToGroupItems(windowId, group?.id);
  const folder = tab.pinnedRow && tab.folderId ? s.pinnedFolders[tab.folderId] : undefined;
  const windows = moveToWindowItems(windowId).filter((item) => "id" in item && item.id !== "window:new");
  // Asleep, or never loaded: nothing to put to sleep.
  const site = normalizeAwakeSite(tab.url);
  const keptAwake = siteKeptAwake(tab.url, s.settings.awakeSites);
  const awake = !!webviews.get(tab.id) && !useLifecycle.getState().discarded[tab.id];

  const choice = await showMenu([
    ...(pinnedPage(tab)
      ? [
          { id: "backToPin", title: "Back to Pinned URL", symbol: "arrow.uturn.backward", enabled: away, ...hint("\r", "command") },
          { id: "replacePin", title: "Replace Pin with Current Page", symbol: "pin", enabled: away },
          { id: "editPin", title: "Edit Pinned Page…", symbol: "pencil" },
          ...(capabilities.calendar && isCalendarUrl(tab.pinnedUrl ?? tab.url) ? [calendarMenuItem()] : []),
          sep,
        ]
      : []),
    // Arc's and Zen's two kinds of pins: a row in the Pinned section, and an Essential (a tile above it).
    { id: "pinRow", title: tab.pinnedRow ? "Unpin Tab" : "Pin Tab", symbol: tab.pinnedRow ? "pin.slash" : "pin", ...hint("d", "shift", "command") },
    { id: "essential", title: tab.pinned ? "Remove from Essentials" : "Add to Essentials", symbol: "square.grid.2x2" },
    { id: "moveToFolder", title: "Move to Folder", symbol: "folder", children: moveToFolderItems(windowId, folder?.id) },
    ...(folder ? [{ id: "leaveFolder", title: "Remove from Folder", symbol: "folder.badge.minus" }] : []),
    // A pin stays anyway.
    ...(pinnedPage(tab) ? [] : [{ id: "keep", title: tab.kept ? "Don’t Keep Tab" : "Keep Tab", symbol: "anchor" }]),
    { id: "rename", title: "Rename…", symbol: "pencil", ...hint("r", "control", "command") },
    ...(tab.customTitle ? [{ id: "resetName", title: "Reset Name", symbol: "arrow.counterclockwise" }] : []),
    sep,
    { id: "duplicate", title: "Duplicate", symbol: "plus.square.on.square" },
    sep,
    { id: "window:new", title: "Move to New Window", symbol: "macwindow.on.rectangle", enabled: !incognito, ...hint("n", "option", "shift", "command") },
    { id: "copyToWindow", title: "Open Copy in New Window", symbol: "macwindow.badge.plus", enabled: !!tab.url },
    sep,
    { id: "siteControls", title: "Site Controls", symbol: "slider.horizontal.3", enabled: !!tab.url },
    { id: "copy", title: "Copy Address", symbol: "link", enabled: !!tab.url, ...hint("c", "shift", "command") },
    { id: "copyMd", title: "Copy Markdown Link", symbol: "m.square", enabled: !!tab.url, ...hint("c", "option", "shift", "command") },
    { id: "moveToSpace", title: "Move to Space", symbol: "square.stack.3d.up", enabled: !incognito, children: moveToSpace },
    ...(!current && active && !split?.tabIds.includes(active) ? [{ id: "split", title: "Split with Current Tab", symbol: "rectangle.split.2x1" }] : []),
    { id: "keepSiteAwake", title: "Keep This Site Awake", symbol: "sun.max", checked: keptAwake, enabled: !!site },
    { id: "sleep", title: "Put Tab to Sleep", symbol: "moon", enabled: !current && awake },
    sep,
    { id: "icon", title: "Change Icon…", symbol: "face.smiling" },
    ...(tab.customIcon ? [{ id: "resetIcon", title: "Reset Icon", symbol: "arrow.counterclockwise" }] : []),
    { id: "mute", title: tab.muted ? "Unmute Site" : "Mute Site", symbol: tab.muted ? "speaker.wave.2" : "speaker.slash", enabled: !!tab.url },
    { id: "bookmark", title: "Add to Bookmarks…", symbol: "bookmark", enabled: !!tab.url, ...hint("d", "command") },
    { id: "bookmarkTo", title: "Add Bookmark to Folder", symbol: "folder", enabled: !!tab.url, children: bookmarkFolderItems(windowId, "folder:") },
    ...(pinnedPage(tab)
      ? []
      : [
          group
            ? { id: "ungroupTab", title: "Remove from Group", symbol: "folder.badge.minus" }
            : { id: "newGroup", title: "New Group with Tab", symbol: "plus.rectangle.on.rectangle", ...hint("n", "control", "command") },
          ...(groups.length ? [{ id: "moveToGroup", title: "Move to Group", symbol: "rectangle.stack", children: groups }] : []),
        ]),
    ...(windows.length && !incognito ? [{ id: "moveToWindow", title: "Move to Window", symbol: "macwindow", children: windows }] : []),
    ...(split ? [{ id: "unsplit", title: "Remove from Split View", symbol: "rectangle.split.2x1.slash", ...hint("-", "shift", "control") }] : []),
    sep,
    { id: "close", title: "Close Tab", symbol: "xmark", ...hint("w", "command") },
    { id: "closeOthers", title: "Close Other Tabs", symbol: "paintbrush", enabled: others.length > 0, ...hint("w", "option", "command") },
    { id: "closeAbove", title: across ? "Close Tabs to the Left" : "Close Tabs Above", symbol: across ? "arrow.left" : "arrow.up", enabled: above.length > 0 },
    {
      id: "closeBelow",
      title: across ? "Close Tabs to the Right" : "Close Tabs Below",
      symbol: across ? "arrow.right" : "arrow.down",
      enabled: below.length > 0,
    },
  ]);
  if (!choice) return;
  const t = { kind: "tab" as const, id: tab.id };
  if (runCalendarMenu(choice)) return;
  if (choice === "backToPin") reportBrowserCommand(returnToPinnedUrl(tab.id));
  else if (choice === "replacePin") reportBrowserCommand(setPinnedUrl(tab.id));
  else if (choice === "editPin") void editPinnedPage(windowId, tab.id);
  else if (choice === "pinRow") reportBrowserCommand(pinRows([tab.id], !tab.pinnedRow));
  else if (choice === "essential") reportBrowserCommand(togglePin(tab.id));
  else if (runFolderChoice(windowId, [tab.id], choice)) return;
  else if (choice === "leaveFolder")
    withFolderMoveUndo(windowId, () =>
      placeTabs([tab.id], { pinned: false, row: true, folderId: folder?.parentId ?? null, beforeId: firstAfterFolder(tab.folderId!) }),
    );
  else if (choice === "keep") useBrowser.getState().updateTab(tab.id, { kept: !tab.kept });
  else if (choice === "rename") void startRename(windowId, t);
  else if (choice === "resetName") useBrowser.getState().updateTab(tab.id, { customTitle: null });
  else if (choice === "duplicate") reportBrowserCommand(duplicateTab(tab.id));
  else if (choice === "copyToWindow") reportBrowserCommand(openWindow(incognito ? { incognito: true, url: tab.url } : { spaceId: tab.spaceId, url: tab.url }));
  else if (choice === "siteControls") {
    switchToTab(tab.id);
    setPopover(tab.id, "siteControls");
  } else if (choice === "copy") copyUrls([tab.id], false);
  else if (choice === "copyMd") copyUrls([tab.id], true);
  else if (choice.startsWith("profile:")) void moveTabToSpace(tab.id, choice.slice(8));
  else if (choice === "split") openInSplit(tab.id);
  else if (choice === "keepSiteAwake" && site) {
    const sites = store().settings.awakeSites;
    reportBrowserCommand(
      updateSettings({ awakeSites: siteKeptAwake(tab.url, sites) ? sites.filter((entry) => !siteKeptAwake(tab.url, [entry])) : [...sites, site] }),
    );
  } else if (choice === "sleep") void sleepTab(tab.id);
  else if (choice === "icon") void openIconPicker(windowId, t);
  else if (choice === "resetIcon") useBrowser.getState().updateTab(tab.id, { customIcon: null });
  else if (choice === "mute") toggleMute(tab.id);
  // Like ⌘D: bookmarks the page (or finds its bookmark) and opens the dialog; never removes one.
  else if (choice === "bookmark") reportBrowserCommand(bookmarkTab(windowId, tab.id));
  else if (choice.startsWith("folder:")) void bookmarkTabs(windowId, [tab.id], choice.slice(7));
  else if (choice === "ungroupTab") reportBrowserCommand(removeTabsFromGroup([tab.id]));
  else if (choice === "newGroup") reportBrowserCommand(newGroupWithSelection(windowId, [tab.id]));
  else if (choice.startsWith("group:")) reportBrowserCommand(placeTabs([tab.id], { pinned: false, groupId: choice.slice(6) }));
  else if (choice.startsWith("window:")) reportBrowserCommand(moveTabToWindow(tab.id, choice.slice(7)));
  else if (choice === "unsplit") reportBrowserCommand(removeTabFromSplit(tab.id));
  else if (choice === "close") reportBrowserCommand(closeTab(tab.id));
  else if (choice === "closeOthers") reportBrowserCommand(closeTabs(others));
  else if (choice === "closeAbove") reportBrowserCommand(closeTabs(above));
  else if (choice === "closeBelow") reportBrowserCommand(closeTabs(below));
}

async function openMultiMenu(windowId: string, ids: string[]) {
  const s = store();
  const n = ids.length;
  const tabs = ids.map((id) => s.tabs[id]!);
  const allPinned = tabs.every((t) => t.pinned);
  const allRows = tabs.every((t) => t.pinnedRow);
  const incognito = tabs.some((t) => isIncognitoSpace(t.spaceId));
  const groups = moveToGroupItems(windowId, undefined);
  const choice = await showMenu([
    { id: "pinRow", title: allRows ? `Unpin ${n} Tabs` : `Pin ${n} Tabs`, symbol: allRows ? "pin.slash" : "pin" },
    { id: "essential", title: allPinned ? `Remove ${n} Tabs from Essentials` : `Add ${n} Tabs to Essentials`, symbol: "square.grid.2x2" },
    { id: "moveToFolder", title: "Move to Folder", symbol: "folder", children: moveToFolderItems(windowId, undefined) },
    sep,
    { id: "duplicate", title: `Duplicate ${n} Tabs`, symbol: "plus.square.on.square" },
    {
      id: "newGroup",
      title: `New Group with ${n} Tabs`,
      symbol: "plus.rectangle.on.rectangle",
      enabled: !tabs.every(pinnedPage),
      ...hint("n", "control", "command"),
    },
    ...(groups.length ? [{ id: "moveToGroup", title: "Move to Group", symbol: "rectangle.stack", children: groups }] : []),
    ...(tabs.some((t) => groupOf(s, t.id)) ? [{ id: "ungroup", title: "Remove from Group", symbol: "folder.badge.minus" }] : []),
    sep,
    { id: "copy", title: `Copy ${n} URLs`, symbol: "link", ...hint("c", "shift", "command") },
    { id: "copyMd", title: `Copy ${n} URLs as Markdown`, symbol: "text.badge.checkmark", ...hint("c", "option", "shift", "command") },
    { id: "bar", title: `Add ${n} Tabs to Bookmarks Bar`, symbol: "bookmark" },
    { id: "bookmarkTo", title: `Add ${n} Tabs to Bookmarks Folder`, symbol: "folder", children: bookmarkFolderItems(windowId, "folder:") },
    sep,
    { id: "moveToWindow", title: "Move to Window", symbol: "macwindow", enabled: !incognito, children: moveToWindowItems(windowId) },
    sep,
    { id: "close", title: `Close ${n} Tabs`, symbol: "xmark", ...hint("w", "command") },
  ]);
  if (!choice) return;
  if (choice === "pinRow") reportBrowserCommand(pinRows(ids, !allRows));
  else if (choice === "essential") reportBrowserCommand(pinTabs(ids, !allPinned));
  else if (runFolderChoice(windowId, ids, choice)) return;
  else if (choice === "duplicate") ids.forEach((id) => reportBrowserCommand(duplicateTab(id)));
  else if (choice === "newGroup") reportBrowserCommand(newGroupWithSelection(windowId, ids));
  else if (choice.startsWith("group:")) reportBrowserCommand(placeTabs(ids, { pinned: false, groupId: choice.slice(6) }));
  else if (choice === "ungroup") reportBrowserCommand(removeTabsFromGroup(ids));
  else if (choice === "copy") copyUrls(ids, false);
  else if (choice === "copyMd") copyUrls(ids, true);
  else if (choice === "bar") void bookmarkTabs(windowId, ids, "bar");
  else if (choice.startsWith("folder:")) void bookmarkTabs(windowId, ids, choice.slice(7));
  else if (choice.startsWith("window:")) {
    const moving = moveTabsToWindow(ids, choice === "window:new" ? null : choice.slice(7)).then((target) =>
      target ? switchToTab(store().windows[target]?.activeTabIds[tabs[0]!.spaceId] ?? ids[0]!) : null,
    );
    reportBrowserCommand(moving);
  } else if (choice === "close") reportBrowserCommand(closeTabs(ids));
  if (choice !== "copy" && choice !== "copyMd") reportBrowserCommand(setSelection(windowId, []));
}

export async function openGroupMenu(windowId: string, groupId: string) {
  const s = store();
  const g = s.groups[groupId];
  if (!g) return;
  const colors: GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  const siteColor = g.tabIds.map((id) => s.live[id]?.themeColor).find(Boolean);
  const matched = siteColor ? nearestGroupColor(siteColor) : null;
  const choice = await showMenu([
    { id: "rename", title: "Rename…", symbol: "character.cursor.ibeam" },
    { id: "icon", title: g.icon ? "Change Icon…" : "Add Icon…", symbol: "face.smiling" },
    {
      id: "color",
      title: "Color",
      symbol: "paintpalette",
      children: [
        { id: "color:", title: "Neutral", checked: !g.color },
        { id: `color:${matched ?? ""}`, title: "Match Site Color", enabled: !!matched, swatch: matched ? GROUP_COLORS[matched].hex : undefined },
        sep,
        ...colors.map((c) => ({ id: `color:${c}`, title: GROUP_COLORS[c].name, swatch: GROUP_COLORS[c].hex, checked: g.color === c })),
      ],
    },
    sep,
    { id: "newTab", title: "New Tab in Group", symbol: "plus", ...hint("t", "option", "command") },
    { id: "pin", title: g.pinned ? "Unpin Group" : "Pin Group", symbol: g.pinned ? "pin.slash" : "pin" },
    { id: "duplicate", title: "Duplicate Group", symbol: "plus.square.on.square" },
    { id: "collapse", title: g.collapsed ? "Expand Group" : "Collapse Group", symbol: g.collapsed ? "chevron.down" : "chevron.up" },
    sep,
    { id: "copy", title: "Copy All Links", symbol: "link" },
    { id: "copyMd", title: "Copy All Links as Markdown", symbol: "text.badge.checkmark" },
    sep,
    { id: "ungroup", title: "Ungroup", symbol: "folder.badge.minus" },
    { id: "bookmarkBar", title: "Move to Bookmark Bar", symbol: "bookmark" },
    { id: "close", title: "Close Group", symbol: "xmark" },
    { id: "delete", title: "Delete Group", symbol: "trash" },
  ]);
  if (!choice) return;
  const target = { kind: "group" as const, id: groupId };
  if (choice === "rename") void startRename(windowId, target);
  else if (choice === "icon") void openIconPicker(windowId, target);
  else if (choice.startsWith("color:")) reportBrowserCommand(updateGroup(groupId, { color: (choice.slice(6) || null) as GroupColor | null }));
  else if (choice === "newTab") {
    useBrowser.getState().openNewTabPanel(windowId, groupId);
  } else if (choice === "pin") reportBrowserCommand(moveGroup(groupId, { pinned: !g.pinned }));
  else if (choice === "duplicate") reportBrowserCommand(duplicateGroup(groupId));
  else if (choice === "collapse") reportBrowserCommand(updateGroup(groupId, { collapsed: !g.collapsed }));
  else if (choice === "copy") copyUrls(g.tabIds, false);
  else if (choice === "copyMd") copyUrls(g.tabIds, true);
  else if (choice === "ungroup") reportBrowserCommand(ungroup(groupId));
  else if (choice === "bookmarkBar") reportBrowserCommand(moveGroupToBookmarksBar(groupId));
  else if (choice === "close") reportBrowserCommand(closeGroup(groupId));
  else if (choice === "delete") reportBrowserCommand(deleteGroup(groupId));
}

// Out of its folder, a row goes just below it.
function firstAfterFolder(folderId: string): string | null {
  const s = store();
  const f = s.pinnedFolders[folderId];
  const ids = f ? listIds(s, spaceListKey(s, f.spaceId)) : [];
  const members = new Set(folderTabIds(s, folderId));
  const last = ids.reduce((at, id, i) => (members.has(id) ? i : at), -1);
  return last < 0 ? null : (ids.slice(last + 1).find((id) => s.tabs[id]?.pinnedRow) ?? null);
}

// Folder operations apply to its descendant tabs too.
export async function openFolderMenu(windowId: string, folderId: string) {
  const s = store();
  const f = s.pinnedFolders[folderId];
  if (!f) return;
  const members = folderTabIds(s, folderId);
  const choice = await showMenu([
    { id: "collapse", title: f.collapsed ? "Open Folder" : "Close Folder", symbol: f.collapsed ? "folder" : "folder.fill" },
    { id: "rename", title: "Rename…", symbol: "character.cursor.ibeam" },
    { id: "icon", title: "Change Icon…", symbol: "face.smiling" },
    ...(f.icon ? [{ id: "resetIcon", title: "Reset Icon", symbol: "arrow.counterclockwise" }] : []),
    sep,
    { id: "newFolder", title: "New Folder Inside", symbol: "folder.badge.plus", enabled: folderDepth(s, folderId) < MAX_FOLDER_DEPTH },
    { id: "moveToFolder", title: "Move to Folder", symbol: "folder", children: moveToFolderItems(windowId, folderId, true) },
    ...(f.parentId ? [{ id: "moveOut", title: "Move Out of Folder", symbol: "folder.badge.minus" }] : []),
    { id: "copy", title: "Copy All Links", symbol: "link", enabled: members.length > 0 },
    { id: "copyMd", title: "Copy All Links as Markdown", symbol: "text.badge.checkmark", enabled: members.length > 0 },
    sep,
    // Its tabs stay pinned, loose, where they were.
    { id: "delete", title: "Remove Folder", symbol: "trash" },
  ]);
  if (!choice) return;
  const target = { kind: "folder" as const, id: folderId };
  if (choice === "rename") void startRename(windowId, target);
  else if (choice === "icon") void openIconPicker(windowId, target);
  else if (choice === "resetIcon") reportBrowserCommand(updatePinnedFolder(folderId, { icon: null }));
  else if (choice === "collapse") reportBrowserCommand(updatePinnedFolder(folderId, { collapsed: !f.collapsed }));
  else if (choice === "copy") copyUrls(members, false);
  else if (choice === "copyMd") copyUrls(members, true);
  else if (choice === "newFolder") reportBrowserCommand(newPinnedFolderWith(windowId, [], folderId));
  else if (choice === "moveOut")
    withFolderMoveUndo(windowId, () => movePinnedFolder(folderId, firstAfterFolder(f.parentId!), s.pinnedFolders[f.parentId!]?.parentId ?? null));
  else if (choice.startsWith("pfolder:")) withFolderMoveUndo(windowId, () => movePinnedFolder(folderId, null, choice.slice(8)));
  else if (choice === "delete") reportBrowserCommand(deletePinnedFolder(folderId));
}

export async function openSidebarMenu(windowId: string) {
  const muted = allMuted(windowId);
  const choice = await showMenu([
    { id: "newTab", title: "New Tab", symbol: "plus", ...hint("t", "command") },
    { id: "search", title: "Search Tabs…", symbol: "magnifyingglass", ...hint("a", "shift", "command") },
    sep,
    { id: "clean", title: "Clean Up Tabs", symbol: "wand.and.stars", ...hint("k", "option", "command") },
    { id: "mute", title: muted ? "Unmute All Tabs" : "Mute All Tabs", symbol: muted ? "speaker.wave.2" : "speaker.slash" },
    { id: "closeAll", title: "Close All Tabs", symbol: "xmark", ...hint("k", "shift", "command") },
    sep,
    { id: "newFolder", title: "New Folder", symbol: "folder.badge.plus" },
    newLiveFolderMenuItem(),
  ]);
  if (choice && runNewLiveFolder(windowId, choice)) return;
  if (choice === "newTab") useBrowser.getState().openNewTabPanel(windowId);
  else if (choice === "newFolder") reportBrowserCommand(newPinnedFolderWith(windowId));
  else if (choice === "search") setSidebarUi({ searchTabs: windowId });
  else if (choice === "clean") reportBrowserCommand(cleanUpTabs(windowId));
  else if (choice === "mute") reportBrowserCommand(muteAll(windowId, !muted));
  else if (choice === "closeAll") closeAllTabs(windowId);
}

export function closeAllTabs(windowId: string) {
  const s = store();
  return closeTabs(viewTabIds(s, windowId).filter((id) => !inPinnedContainer(s, id)));
}

export async function openOverflowMenu(windowId: string) {
  const s = store();
  const w = s.windows[windowId];
  if (!w) return;
  const muted = allMuted(windowId);
  const open = viewTabIds(s, windowId).map((id) => s.tabs[id]!);
  const closed = [
    ...s.closedTabs
      .filter((c) => c.tab.spaceId === w.spaceId)
      .map((c) => ({ id: `restore:${c.id}`, title: c.tab.customTitle || c.tab.title || tabLabel(c.tab), symbol: "clock.arrow.circlepath", at: c.closedAt })),
    ...s.closedGroups.map((c) => ({
      id: `restore:${c.id}`,
      title: `${c.group.name} (${plural(c.tabs.length, "Tab")})`,
      symbol: "rectangle.stack",
      at: c.closedAt,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 15)
    .map((item) => ({ id: item.id, title: item.title, symbol: item.symbol }));
  const allCleaned = cleanedTabsFor(s, windowId);
  const cleaned = [...allCleaned].reverse().slice(0, 20);
  const deleted = keptDeletedGroups(s.deletedGroups)
    .reverse()
    .map((c) => ({ id: `restore:${c.id}`, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})`, symbol: "trash" }));
  const daily = s.settings.cleanUpInactiveTabsAfterHours !== null;
  const synced = syncedDevicesMenuItem(w.spaceId);
  const choice = await showMenu([
    { id: "search", title: "Search Tabs…", symbol: "magnifyingglass", ...hint("a", "shift", "command") },
    sep,
    {
      id: "open",
      title: "Open Tabs",
      symbol: "square.stack",
      enabled: open.length > 0,
      children: open.map((t) => ({ id: `tab:${t.id}`, title: tabTitle(t), checked: w.activeTabIds[w.spaceId] === t.id })),
    },
    ...(synced ? [synced] : []),
    {
      id: "closed",
      title: "Recently Closed",
      symbol: "clock.arrow.circlepath",
      enabled: closed.length > 0,
      children: closed.length ? closed : [{ id: "none", title: "Empty", enabled: false }],
    },
    {
      id: "cleaned",
      title: "Recently Cleaned",
      symbol: "wand.and.stars",
      enabled: cleaned.length > 0,
      children: cleaned.length
        ? [
            ...cleaned.map((c) => ({ id: `cleaned:${c.id}`, title: c.tab.customTitle || c.tab.title || tabLabel(c.tab) })),
            sep,
            { id: "restoreAll", title: `Restore ${plural(allCleaned.length, "Tab")}` },
          ]
        : [{ id: "none", title: "Empty", enabled: false }],
    },
    ...(deleted.length ? [{ id: "deleted", title: "Recently Deleted Groups", symbol: "trash", children: deleted }] : []),
    sep,
    { id: "clean", title: "Clean Up Tabs", symbol: "wand.and.stars", ...hint("k", "option", "command") },
    { id: "daily", title: "Clean Up Daily", checked: daily },
    sep,
    { id: "mute", title: muted ? "Unmute All Tabs" : "Mute All Tabs", symbol: muted ? "speaker.wave.2" : "speaker.slash" },
    { id: "closeAll", title: "Close All Tabs", symbol: "xmark", ...hint("k", "shift", "command") },
  ]);
  if (!choice) return;
  if (choice === "search") setSidebarUi({ searchTabs: windowId });
  else if (choice.startsWith("tab:")) reportBrowserCommand(switchToTab(choice.slice(4)));
  else if (openSyncedTab(choice, windowId, w.spaceId)) return;
  else if (choice.startsWith("restore:")) reportBrowserCommand(restoreClosed(choice.slice(8), windowId));
  else if (choice.startsWith("cleaned:")) reportBrowserCommand(restoreCleaned(windowId, choice.slice(8)));
  else if (choice === "restoreAll") reportBrowserCommand(restoreCleaned(windowId));
  else if (choice === "clean") reportBrowserCommand(cleanUpTabs(windowId));
  else if (choice === "daily") reportBrowserCommand(updateSettings({ cleanUpInactiveTabsAfterHours: daily ? null : 24 }));
  else if (choice === "mute") reportBrowserCommand(muteAll(windowId, !muted));
  else if (choice === "closeAll") reportBrowserCommand(closeAllTabs(windowId));
}
