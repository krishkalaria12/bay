import type { GroupPlacement, TabPlacement } from "../store/organize";
import type { GroupColor } from "../store/types";
import { dispatchBrowserCommand } from "./commands";
import type { FolderPatch, GroupPatch, NewFolderOptions } from "./organizeCommands";

export const createGroup = (tabIds: string[], options?: { name?: string; icon?: string | null; color?: GroupColor | null }) =>
  dispatchBrowserCommand({ method: "createGroup", tabIds, options });
export const groupTabs = (tabIds: string[], options?: { pinned?: boolean; name?: string }) => dispatchBrowserCommand({ method: "groupTabs", tabIds, options });
export const updateGroup = (groupId: string, patch: GroupPatch) => dispatchBrowserCommand({ method: "updateGroup", groupId, patch });
export const addTabsToGroup = (groupId: string, tabIds: string[]) => dispatchBrowserCommand({ method: "addTabsToGroup", groupId, tabIds });
export const removeTabsFromGroup = (tabIds: string[]) => dispatchBrowserCommand({ method: "removeTabsFromGroup", tabIds });
export const ungroup = (groupId: string) => dispatchBrowserCommand({ method: "ungroup", groupId });
export const closeGroup = (groupId: string) => dispatchBrowserCommand({ method: "closeGroup", groupId });
export const deleteGroup = (groupId: string) => dispatchBrowserCommand({ method: "deleteGroup", groupId });
export const duplicateGroup = (groupId: string) => dispatchBrowserCommand({ method: "duplicateGroup", groupId });
export const moveGroupToBookmarksBar = (groupId: string) => dispatchBrowserCommand({ method: "moveGroupToBookmarksBar", groupId });
export const moveGroup = (groupId: string, placement: GroupPlacement) => dispatchBrowserCommand({ method: "moveGroup", groupId, placement });
export const newTabInGroup = (groupId: string, url?: string) => dispatchBrowserCommand({ method: "newTabInGroup", groupId, url });

export const newPinnedFolder = (windowId: string, options?: NewFolderOptions) => dispatchBrowserCommand({ method: "newPinnedFolder", windowId, options });
export const updatePinnedFolder = (folderId: string, patch: FolderPatch) => dispatchBrowserCommand({ method: "updatePinnedFolder", folderId, patch });
export const movePinnedFolder = (folderId: string, beforeId: string | null, parentId?: string | null) =>
  dispatchBrowserCommand({ method: "movePinnedFolder", folderId, beforeId, parentId });
export const deletePinnedFolder = (folderId: string) => dispatchBrowserCommand({ method: "deletePinnedFolder", folderId });
export const undoPinnedFolderMove = () => dispatchBrowserCommand({ method: "undoPinnedFolderMove" });

export const setSelection = (windowId: string, tabIds: string[]) => dispatchBrowserCommand({ method: "setSelection", windowId, tabIds });
export const placeTabs = (tabIds: string[], placement: TabPlacement) => dispatchBrowserCommand({ method: "placeTabs", tabIds, placement });
export const pinTabs = (tabIds: string[], pinned: boolean) => dispatchBrowserCommand({ method: "pinTabs", tabIds, pinned });
export const pinRows = (tabIds: string[], pinned: boolean) => dispatchBrowserCommand({ method: "pinRows", tabIds, pinned });
export const setMuted = (tabIds: string[], muted: boolean) => dispatchBrowserCommand({ method: "setMuted", tabIds, muted });
export const setSiteMuted = (tabId: string, muted: boolean) => dispatchBrowserCommand({ method: "setSiteMuted", tabId, muted });
export const returnToPinnedUrl = (tabId: string) => dispatchBrowserCommand({ method: "returnToPinnedUrl", tabId });
export const setPinnedUrl = (tabId: string, url?: string) => dispatchBrowserCommand({ method: "setPinnedUrl", tabId, url });
export const cleanUpTabs = (windowId: string, options?: { inactiveForMs?: number; spaceId?: string }) =>
  dispatchBrowserCommand({ method: "cleanUpTabs", windowId, options });
export const restoreCleaned = (windowId: string, entryId?: string) => dispatchBrowserCommand({ method: "restoreCleaned", windowId, entryId });
