import { decodeSharedCollection } from "@bay/core";
import type { BrowserState, BrowserStore } from "../store/browser";
import { isIncognitoSpace } from "../store/model";
import type { GroupPlacement, TabPlacement } from "../store/organize";
import type { GroupColor, PinnedFolder, TabGroup } from "../store/types";
import {
  commandBoolean,
  commandFields,
  commandIds,
  commandNullableText,
  commandObject,
  commandOptionalText,
  commandText,
  commandUrl,
  invalidCommand,
  requireCommandFolder,
  requireCommandGroup,
  requireCommandSpace,
  requireCommandTab,
  requireCommandTabs,
  requireCommandWindow,
  type CommandReaders,
} from "./commandValidation";

export type GroupPatch = Partial<Pick<TabGroup, "name" | "icon" | "color" | "collapsed" | "pinned">>;
export type FolderPatch = Partial<Pick<PinnedFolder, "name" | "icon" | "collapsed">>;
export type NewFolderOptions = { tabIds?: string[]; name?: string; parentId?: string; spaceId?: string; beforeId?: string };
export type OrganizeCommand =
  | { method: "createGroup"; tabIds: string[]; options?: { name?: string; icon?: string | null; color?: GroupColor | null } }
  | { method: "groupTabs"; tabIds: string[]; options?: { pinned?: boolean; name?: string } }
  | { method: "updateGroup"; groupId: string; patch: GroupPatch }
  | { method: "addTabsToGroup"; groupId: string; tabIds: string[] }
  | { method: "removeTabsFromGroup"; tabIds: string[] }
  | { method: "ungroup" | "closeGroup" | "deleteGroup" | "duplicateGroup" | "moveGroupToBookmarksBar"; groupId: string }
  | { method: "moveGroup"; groupId: string; placement: GroupPlacement }
  | { method: "newTabInGroup"; groupId: string; url?: string }
  | { method: "newPinnedFolder"; windowId: string; options?: NewFolderOptions }
  | { method: "addSharedCollection"; windowId: string; token: string; spaceId?: string }
  | { method: "updatePinnedFolder"; folderId: string; patch: FolderPatch }
  | { method: "movePinnedFolder"; folderId: string; beforeId: string | null; parentId?: string | null }
  | { method: "deletePinnedFolder"; folderId: string }
  | { method: "undoPinnedFolderMove" }
  | { method: "undoSidebarEdit"; windowId: string }
  | { method: "setSelection"; windowId: string; tabIds: string[] }
  | { method: "placeTabs"; tabIds: string[]; placement: TabPlacement }
  | { method: "pinTabs" | "pinRows"; tabIds: string[]; pinned: boolean }
  | { method: "setMuted"; tabIds: string[]; muted: boolean }
  | { method: "setSiteMuted"; tabId: string; muted: boolean }
  | { method: "returnToPinnedUrl"; tabId: string }
  | { method: "setPinnedUrl"; tabId: string; url?: string }
  | { method: "cleanUpTabs"; windowId: string; options?: { inactiveForMs?: number; spaceId?: string } }
  | { method: "restoreCleaned"; windowId: string; entryId?: string };

export const ORGANIZE_COMMAND_METHODS = [
  "createGroup",
  "groupTabs",
  "updateGroup",
  "addTabsToGroup",
  "removeTabsFromGroup",
  "ungroup",
  "closeGroup",
  "deleteGroup",
  "duplicateGroup",
  "moveGroupToBookmarksBar",
  "moveGroup",
  "newTabInGroup",
  "newPinnedFolder",
  "addSharedCollection",
  "updatePinnedFolder",
  "movePinnedFolder",
  "deletePinnedFolder",
  "undoPinnedFolderMove",
  "undoSidebarEdit",
  "setSelection",
  "placeTabs",
  "pinTabs",
  "pinRows",
  "setMuted",
  "setSiteMuted",
  "returnToPinnedUrl",
  "setPinnedUrl",
  "cleanUpTabs",
  "restoreCleaned",
] as const;

const GROUP_COLORS: readonly string[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const color = (value: unknown): GroupColor | null =>
  value === null || (typeof value === "string" && GROUP_COLORS.includes(value)) ? (value as GroupColor | null) : invalidCommand("invalid group color");
const name = (value: unknown) => commandText(value, 1024, true);
const icon = commandNullableText;

export function parseOrganizeCommand(value: unknown): OrganizeCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const tabIds = () => commandIds(c.tabIds);
  const groupId = () => commandText(c.groupId);
  const folderId = () => commandText(c.folderId);
  const windowId = () => commandText(c.windowId);
  const tabId = () => commandText(c.tabId);
  const options = <T>(allowed: string[], readers: CommandReaders<T>) =>
    c.options !== undefined ? { options: commandFields<T>(commandObject(c.options, allowed), readers) } : {};
  switch (c.method) {
    case "createGroup":
      fields("tabIds", "options");
      return { method: c.method, tabIds: tabIds(), ...options(["name", "icon", "color"], { name, icon, color }) };
    case "groupTabs":
      fields("tabIds", "options");
      return { method: c.method, tabIds: tabIds(), ...options(["pinned", "name"], { pinned: commandBoolean, name }) };
    case "updateGroup":
      fields("groupId", "patch");
      return {
        method: c.method,
        groupId: groupId(),
        patch: commandFields<GroupPatch>(commandObject(c.patch, ["name", "icon", "color", "collapsed", "pinned"]), {
          name,
          icon,
          color,
          collapsed: commandBoolean,
          pinned: commandBoolean,
        }),
      };
    case "addTabsToGroup":
      fields("groupId", "tabIds");
      return { method: c.method, groupId: groupId(), tabIds: tabIds() };
    case "removeTabsFromGroup":
      fields("tabIds");
      return { method: c.method, tabIds: tabIds() };
    case "ungroup":
    case "closeGroup":
    case "deleteGroup":
    case "duplicateGroup":
    case "moveGroupToBookmarksBar":
      fields("groupId");
      return { method: c.method, groupId: groupId() };
    case "moveGroup": {
      fields("groupId", "placement");
      const p = commandObject(c.placement, ["pinned", "beforeId"]);
      return {
        method: c.method,
        groupId: groupId(),
        placement: { pinned: commandBoolean(p.pinned), ...(p.beforeId !== undefined ? { beforeId: commandOptionalText(p.beforeId) } : {}) },
      };
    }
    case "newTabInGroup":
      fields("groupId", "url");
      return { method: c.method, groupId: groupId(), ...(c.url !== undefined ? { url: commandUrl(c.url) } : {}) };
    case "newPinnedFolder":
      fields("windowId", "options");
      return {
        method: c.method,
        windowId: windowId(),
        ...options<NewFolderOptions>(["tabIds", "name", "parentId", "spaceId", "beforeId"], {
          tabIds: commandIds,
          name,
          parentId: commandText,
          spaceId: commandText,
          beforeId: commandText,
        }),
      };
    case "addSharedCollection": {
      fields("windowId", "token", "spaceId");
      const token = commandText(c.token, 16_000);
      try {
        decodeSharedCollection(token);
      } catch {
        return invalidCommand("invalid shared collection");
      }
      return { method: c.method, windowId: windowId(), token, ...(c.spaceId !== undefined ? { spaceId: commandText(c.spaceId) } : {}) };
    }
    case "updatePinnedFolder":
      fields("folderId", "patch");
      return {
        method: c.method,
        folderId: folderId(),
        patch: commandFields<FolderPatch>(commandObject(c.patch, ["name", "icon", "collapsed"]), { name, icon, collapsed: commandBoolean }),
      };
    case "movePinnedFolder":
      fields("folderId", "beforeId", "parentId");
      if (c.beforeId === undefined) return invalidCommand("missing folder position");
      return {
        method: c.method,
        folderId: folderId(),
        beforeId: commandOptionalText(c.beforeId),
        ...(c.parentId !== undefined ? { parentId: commandOptionalText(c.parentId) } : {}),
      };
    case "deletePinnedFolder":
      fields("folderId");
      return { method: c.method, folderId: folderId() };
    case "undoSidebarEdit":
      fields("windowId");
      return { method: c.method, windowId: windowId() };
    case "undoPinnedFolderMove":
      fields();
      return { method: c.method };
    case "setSelection":
      fields("windowId", "tabIds");
      return { method: c.method, windowId: windowId(), tabIds: tabIds() };
    case "placeTabs": {
      fields("tabIds", "placement");
      const p = commandObject(c.placement, ["pinned", "row", "folderId", "beforeId", "groupId"]);
      return {
        method: c.method,
        tabIds: tabIds(),
        placement: {
          pinned: commandBoolean(p.pinned),
          ...commandFields<Omit<TabPlacement, "pinned">>(p, {
            row: commandBoolean,
            folderId: commandOptionalText,
            beforeId: commandOptionalText,
            groupId: commandOptionalText,
          }),
        },
      };
    }
    case "pinTabs":
    case "pinRows":
      fields("tabIds", "pinned");
      return { method: c.method, tabIds: tabIds(), pinned: commandBoolean(c.pinned) };
    case "setMuted":
      fields("tabIds", "muted");
      return { method: c.method, tabIds: tabIds(), muted: commandBoolean(c.muted) };
    case "setSiteMuted":
      fields("tabId", "muted");
      return { method: c.method, tabId: tabId(), muted: commandBoolean(c.muted) };
    case "returnToPinnedUrl":
      fields("tabId");
      return { method: c.method, tabId: tabId() };
    case "setPinnedUrl":
      fields("tabId", "url");
      return { method: c.method, tabId: tabId(), ...(c.url !== undefined ? { url: commandUrl(c.url) } : {}) };
    case "cleanUpTabs":
      fields("windowId", "options");
      return {
        method: c.method,
        windowId: windowId(),
        ...options<{ inactiveForMs?: number; spaceId?: string }>(["inactiveForMs", "spaceId"], {
          inactiveForMs: (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalidCommand("invalid clean up age")),
          spaceId: commandText,
        }),
      };
    case "restoreCleaned":
      fields("windowId", "entryId");
      return { method: c.method, windowId: windowId(), ...(c.entryId !== undefined ? { entryId: commandText(c.entryId) } : {}) };
    default:
      return invalidCommand("unknown organize command");
  }
}

// A tab joins a group or folder only within its own space.
const sameSpace = (spaceId: string, tabs: readonly { spaceId: string }[]) =>
  tabs.every((tab) => tab.spaceId === spaceId) || invalidCommand("tabs belong to another space");

function requirePlacement(s: BrowserState, ids: string[], p: TabPlacement) {
  const tabs = requireCommandTabs(s, ids);
  const spaceId = tabs[0]?.spaceId;
  if (p.folderId && requireCommandFolder(s, p.folderId).spaceId !== spaceId) return invalidCommand("folder belongs to another space");
  if (p.groupId && requireCommandGroup(s, p.groupId).spaceId !== spaceId) return invalidCommand("group belongs to another space");
  if (p.beforeId) sameSpace(spaceId ?? "", [requireCommandTab(s, p.beforeId)]);
}

/** Folder anchors are a sibling row or folder of the same space. */
function requireFolderAnchor(s: BrowserState, spaceId: string, id: string) {
  const anchor = Object.hasOwn(s.pinnedFolders, id) ? requireCommandFolder(s, id) : requireCommandTab(s, id);
  if (anchor.spaceId !== spaceId) return invalidCommand("folder position belongs to another space");
}

function requireCleanedEntry(s: BrowserState, windowId: string, entryId: string | undefined) {
  const window = requireCommandWindow(s, windowId);
  // Public windows only restore public entries; a private window only its own.
  const entries = window.incognito ? (s.privateCleanedTabs[windowId] ?? []) : s.cleanedTabs;
  if (entryId && !entries.some((entry) => entry.id === entryId)) return invalidCommand("cleaned up tab no longer exists");
}

export function executeOrganizeCommand(store: BrowserStore, command: OrganizeCommand): string | null {
  const s = store.getState();
  // Reducers return "" when nothing was created; an ID result is never empty.
  const created = (id: string) => id || invalidCommand("command had no effect");
  switch (command.method) {
    case "createGroup":
      requireCommandTabs(s, command.tabIds);
      return created(s.createGroup(command.tabIds, command.options));
    case "groupTabs":
      requireCommandTabs(s, command.tabIds);
      return created(s.groupTabs(command.tabIds, command.options));
    case "updateGroup":
      requireCommandGroup(s, command.groupId);
      s.updateGroup(command.groupId, command.patch);
      break;
    case "addTabsToGroup":
      sameSpace(requireCommandGroup(s, command.groupId).spaceId, requireCommandTabs(s, command.tabIds));
      s.addTabsToGroup(command.groupId, command.tabIds);
      break;
    case "removeTabsFromGroup":
      requireCommandTabs(s, command.tabIds);
      s.removeTabsFromGroup(command.tabIds);
      break;
    case "ungroup":
    case "closeGroup":
    case "deleteGroup":
    case "moveGroupToBookmarksBar":
      requireCommandGroup(s, command.groupId);
      s[command.method](command.groupId);
      break;
    case "duplicateGroup":
      requireCommandGroup(s, command.groupId);
      return created(s.duplicateGroup(command.groupId));
    case "moveGroup": {
      const group = requireCommandGroup(s, command.groupId);
      if (command.placement.beforeId) sameSpace(group.spaceId, [requireCommandTab(s, command.placement.beforeId)]);
      s.moveGroup(command.groupId, command.placement);
      break;
    }
    case "newTabInGroup":
      requireCommandGroup(s, command.groupId);
      return created(s.newTabInGroup(command.groupId, command.url));
    case "newPinnedFolder": {
      const window = requireCommandWindow(s, command.windowId);
      if (window.incognito || window.kind === "small") return invalidCommand("window cannot hold pinned folders");
      const o = command.options ?? {};
      const spaceId = o.spaceId ?? window.spaceId;
      requireCommandSpace(s, spaceId);
      if (o.parentId && requireCommandFolder(s, o.parentId).spaceId !== spaceId) return invalidCommand("folder belongs to another space");
      if (o.beforeId) requireFolderAnchor(s, spaceId, o.beforeId);
      if (o.tabIds) sameSpace(spaceId, requireCommandTabs(s, o.tabIds));
      return created(s.newPinnedFolder(command.windowId, command.options));
    }
    case "addSharedCollection": {
      const window = requireCommandWindow(s, command.windowId);
      if (window.incognito || window.kind === "small") return invalidCommand("window cannot hold pinned folders");
      requireCommandSpace(s, command.spaceId ?? window.spaceId);
      return created(s.importSharedCollection(command.windowId, decodeSharedCollection(command.token), command.spaceId));
    }
    case "updatePinnedFolder":
      requireCommandFolder(s, command.folderId);
      s.updatePinnedFolder(command.folderId, command.patch);
      break;
    case "movePinnedFolder": {
      const folder = requireCommandFolder(s, command.folderId);
      if (command.parentId && requireCommandFolder(s, command.parentId).spaceId !== folder.spaceId) return invalidCommand("folder belongs to another space");
      if (command.beforeId) requireFolderAnchor(s, folder.spaceId, command.beforeId);
      s.movePinnedFolder(command.folderId, command.beforeId, command.parentId);
      break;
    }
    case "deletePinnedFolder":
      requireCommandFolder(s, command.folderId);
      s.deletePinnedFolder(command.folderId);
      break;
    case "undoSidebarEdit":
      requireCommandWindow(s, command.windowId);
      s.undoSidebarEdit(command.windowId);
      break;
    case "undoPinnedFolderMove":
      s.undoPinnedFolderMove();
      break;
    case "setSelection": {
      const window = requireCommandWindow(s, command.windowId);
      for (const tab of requireCommandTabs(s, command.tabIds))
        if (window.incognito ? tab.spaceId !== window.spaceId : isIncognitoSpace(tab.spaceId))
          return invalidCommand("tab cannot cross private window boundaries");
      s.setSelection(command.windowId, command.tabIds);
      break;
    }
    case "placeTabs":
      requirePlacement(s, command.tabIds, command.placement);
      s.placeTabs(command.tabIds, command.placement);
      break;
    case "pinTabs":
    case "pinRows":
      requireCommandTabs(s, command.tabIds);
      s[command.method](command.tabIds, command.pinned);
      break;
    case "setMuted":
      requireCommandTabs(s, command.tabIds);
      s.setMuted(command.tabIds, command.muted);
      break;
    case "setSiteMuted":
      requireCommandTab(s, command.tabId);
      s.setSiteMuted(command.tabId, command.muted);
      break;
    case "returnToPinnedUrl":
      requireCommandTab(s, command.tabId);
      s.returnToPinnedUrl(command.tabId);
      break;
    case "setPinnedUrl":
      requireCommandTab(s, command.tabId);
      s.setPinnedUrl(command.tabId, command.url);
      break;
    case "cleanUpTabs": {
      const window = requireCommandWindow(s, command.windowId);
      const spaceId = command.options?.spaceId;
      if (spaceId && window.incognito && spaceId !== window.spaceId) return invalidCommand("space does not belong to this window");
      if (spaceId && !window.incognito) requireCommandSpace(s, spaceId);
      s.cleanUpTabs(command.windowId, command.options);
      break;
    }
    case "restoreCleaned":
      requireCleanedEntry(s, command.windowId, command.entryId);
      return s.restoreCleaned(command.entryId, command.windowId) ?? null;
  }
  return null;
}
