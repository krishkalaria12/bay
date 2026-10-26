import { decodeSharedCollection, encodeSharedCollection, type SharedCollection, type SharedItem } from "@bay/core";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { MAX_FOLDER_DEPTH } from "./folders";
import { orderSections } from "./groups";
import { IDLE_LIVE, isIncognitoSpace, listIds, makeTab, newId, spaceListKey } from "./model";

export type SharedCollectionsSlice = {
  importSharedCollection(windowId: string, collection: SharedCollection, spaceId?: string): string;
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
      pinnedFolders[id] = { id, spaceId, name: title, icon: null, collapsed: false, createdAt: Date.now(), ...(parentId ? { parentId } : {}) };
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
});
