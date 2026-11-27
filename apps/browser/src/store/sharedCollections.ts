import { decodeSharedCollection, encodeSharedCollection, type SharedCollection, type SharedItem } from "@bay/core";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browserStore";
import { MAX_FOLDER_DEPTH } from "./folders";
import { orderSections } from "./groups";
import { IDLE_LIVE, isIncognitoSpace, listIds, makeTab, newId, spaceListKey } from "./model";
import { removeTabs } from "./tabs";

export type SharedLinkChanges = {
  add: { url: string; title: string }[];
  remove: string[];
  update: { tabId: string; url: string; title: string }[];
};

export type SharedCollectionsSlice = {
  importSharedCollection(windowId: string, collection: SharedCollection, spaceId?: string): string;
  /** A shared folder's directory changed (lib/sharedFolderService.ts): its links come in as pinned rows that don't
   *  load, go, or take a new address. The added tabs' ids, in order; none if the folder is gone. */
  applySharedLinks(folderId: string, changes: SharedLinkChanges): string[];
};

export function checkSharedFolderDepth(collection: SharedCollection) {
  const visit = (items: SharedItem[], depth: number) => {
    if (depth > MAX_FOLDER_DEPTH) throw new Error(`Bay supports folders up to ${MAX_FOLDER_DEPTH} levels deep.`);

    for (const item of items) if (item.kind === "folder") visit(item.children, depth + 1);
  };

  visit(collection.children, 1);
}

export const createSharedCollectionsSlice: StateCreator<BrowserState, [], [], SharedCollectionsSlice> = (set, get) => ({
  importSharedCollection(windowId, input, requestedSpace) {
    // Validate before creating anything, including when called outside the URL import flow.
    const collection = decodeSharedCollection(encodeSharedCollection(input));
    checkSharedFolderDepth(collection);
    const s = get();
    const window = s.windows[windowId];
    const spaceId = requestedSpace ?? window?.spaceId;

    if (!window || window.incognito || window.kind === "small" || !spaceId || isIncognitoSpace(spaceId) || !s.spaces[spaceId]) {
      throw new Error("Choose a regular Bay window to add this folder.");
    }

    const tabs = { ...s.tabs };
    const live = { ...s.live };
    const pinnedFolders = { ...s.pinnedFolders };
    const added: string[] = [];

    const addFolder = (title: string, children: SharedItem[], parentId?: string): string => {
      const id = newId("pf");
      pinnedFolders[id] = { id, spaceId, name: title, icon: null, collapsed: false, createdAt: Date.now(), ...(parentId ? { parentId } : undefined) };

      const entries = children.map((item) => {
        if (item.kind === "folder") return addFolder(item.title, item.children, id);
        const tab = makeTab(windowId, spaceId, item.url, { title: item.title, customTitle: item.title || null, pinnedRow: true, pinnedUrl: item.url });
        // A shared folder is a set of saved links. Opening it must not load every website.
        tabs[tab.id] = { ...tab, folderId: id, navigation: null, unloaded: true };
        live[tab.id] = IDLE_LIVE;
        added.push(tab.id);

        return tab.id;
      });

      // Empty folders need an explicit anchor to retain their position among direct rows.
      entries.forEach((entry, index) => {
        if (pinnedFolders[entry] && entries[index + 1]) pinnedFolders[entry] = { ...pinnedFolders[entry], beforeId: entries[index + 1] };
      });

      return id;
    };

    const rootId = addFolder(collection.title, collection.children);
    const key = spaceListKey(s, spaceId);
    const tabIds = orderSections([...listIds(s, key), ...added], tabs, s.groups, pinnedFolders);
    set({ tabs, live, pinnedFolders, tabLists: { ...s.tabLists, [key]: tabIds } });

    return rootId;
  },

  applySharedLinks(folderId, { add, remove, update }) {
    const s = get();
    const folder = s.pinnedFolders[folderId];

    const windowId =
      s.windowOrder.find((id) => s.windows[id]?.spaceId === folder?.spaceId && !s.windows[id]?.incognito) ??
      s.windowOrder.find((id) => !s.windows[id]?.incognito);

    if (!folder || !windowId) return [];

    let next = removeTabs(
      s,
      remove.filter((id) => s.tabs[id]?.folderId === folderId),
      false,
    );

    const tabs = { ...next.tabs };
    const live = { ...next.live };
    const added: string[] = [];

    for (const change of update) {
      const t = tabs[change.tabId];

      // A page that's open keeps showing what it shows; its pinned page is the new address.
      if (t?.folderId === folderId) tabs[t.id] = { ...t, pinnedUrl: change.url, customTitle: change.title, ...(t.unloaded ? { url: change.url } : undefined) };
    }

    for (const link of add) {
      const tab = makeTab(windowId, folder.spaceId, link.url, { title: link.title, customTitle: link.title, pinnedRow: true, pinnedUrl: link.url });
      tabs[tab.id] = { ...tab, folderId, navigation: null, unloaded: true };
      live[tab.id] = IDLE_LIVE;
      added.push(tab.id);
    }

    const key = spaceListKey(next, folder.spaceId);
    const tabIds = orderSections([...listIds(next, key), ...added], tabs, next.groups, next.pinnedFolders);
    next = { ...next, tabs, live, tabLists: { ...next.tabLists, [key]: tabIds } };
    set(next);

    return added;
  },
});
