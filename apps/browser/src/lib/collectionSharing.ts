import { decodeSharedCollection, sharedCollectionToken, sharedCollectionUrl, sharedLinkCount, type SharedCollection, type SharedItem } from "@bay/core";
import { confirm, copyText, focusWindow } from "@bay/shell";
import { folderEntries } from "../components/sidebar/entries";
import { showToast } from "../components/layout/toasts";
import { useBrowser, type BrowserState } from "../store/browser";
import { isIncognitoSpace, tabLabel } from "../store/model";
import { checkSharedFolderDepth } from "../store/sharedCollections";

export type CollectionSource = { kind: "folder"; id: string } | { kind: "split"; id: string } | { kind: "selection"; tabIds: string[] };

export function collectionSnapshot(s: BrowserState, source: CollectionSource): SharedCollection {
  const link = (id: string): SharedItem => {
    const tab = s.tabs[id];
    if (!tab) throw new Error("One of these tabs is no longer available.");
    if (isIncognitoSpace(tab.spaceId) || s.windows[tab.windowId]?.incognito) throw new Error("Private tabs cannot be shared as a collection.");
    return { kind: "link", title: tab.customTitle || tab.title || tabLabel(tab), url: tab.url };
  };
  if (source.kind === "folder") {
    const seen = new Set<string>();
    const folder = (id: string): Extract<SharedItem, { kind: "folder" }> => {
      const f = s.pinnedFolders[id];
      if (!f || seen.has(id)) throw new Error("This folder is no longer available.");
      if (isIncognitoSpace(f.spaceId)) throw new Error("Private folders cannot be shared.");
      seen.add(id);
      return {
        kind: "folder",
        title: f.name || "New Folder",
        children: folderEntries(s, id).map((entry) => (entry.startsWith("f:") ? folder(entry.slice(2)) : link(entry.slice(2)))),
      };
    };
    const root = folder(source.id);
    return { version: 1, kind: "folder", title: root.title, children: root.children };
  }
  const ids = source.kind === "split" ? s.splits[source.id]?.tabIds : [...new Set(source.tabIds)];
  if (!ids?.length) throw new Error("There are no tabs to share.");
  return { version: 1, kind: source.kind, title: source.kind === "split" ? "Shared Split View" : "Shared Tabs", children: ids.map(link) };
}

export async function shareCollection(windowId: string, source: CollectionSource) {
  try {
    const s = useBrowser.getState();
    const window = s.windows[windowId];
    if (!window || window.incognito) throw new Error("Choose a regular Bay window to share this collection.");
    const collection = collectionSnapshot(s, source);
    const url = sharedCollectionUrl(collection);
    const count = sharedLinkCount(collection);
    const { confirmed } = await confirm({
      title: `Share "${collection.title}"?`,
      message: `Anyone with this link can read these ${count} tab titles and addresses. It is a snapshot; later changes are not included. The link contains the collection and cannot be revoked. Large collections may exceed some apps' link limits.`,
      confirmTitle: "Copy Share Link",
      windowId,
    });
    if (!confirmed) return;
    copyText(url);
    showToast(windowId, "Share Link Copied", `${count} ${count === 1 ? "link" : "links"} ready to send.`, { icon: "link" });
  } catch (error) {
    showToast(windowId, "Cannot Share Collection", error instanceof Error ? error.message : "The share link could not be created.");
  }
}

const pendingImports = new Set<string>();
let importQueue = Promise.resolve();

// Consume app links before external-link routing or Chrome can open them as a page.
export function handleSharedCollectionUrl(url: string, windowId?: string): boolean {
  if (!/^bay:\/\/share(?:[/?#]|$)/i.test(url)) return false;
  if (pendingImports.has(url)) return true;
  pendingImports.add(url);
  importQueue = importQueue.then(() => importCollectionUrl(url, windowId)).finally(() => pendingImports.delete(url));
  return true;
}

function importWindow(s: BrowserState, requested?: string) {
  return (
    [...new Set([requested, s.ui.focusedWindowId, ...s.ui.focusOrder, ...s.windowOrder])].find((id) => {
      const w = id ? s.windows[id] : undefined;
      return w && !w.incognito && w.kind !== "small";
    }) ?? undefined
  );
}

export async function importCollectionUrl(url: string, requestedWindow?: string) {
  let windowId = importWindow(useBrowser.getState(), requestedWindow);
  try {
    const token = sharedCollectionToken(url);
    if (!token) throw new Error("This shared collection link is invalid or incomplete.");
    const collection = decodeSharedCollection(token);
    checkSharedFolderDepth(collection);
    const count = sharedLinkCount(collection);
    const s = useBrowser.getState();
    const spaceId = windowId ? s.windows[windowId]?.spaceId : undefined;
    const name = spaceId ? s.spaces[spaceId]?.name : undefined;
    const { confirmed } = await confirm({
      title: `Add "${collection.title}" to Bay?`,
      message: `Add ${count} ${count === 1 ? "link" : "links"} as a folder${name ? ` in "${name}"` : ""}. Nested folders are preserved. Websites will load only when you open their tabs.`,
      confirmTitle: "Add Folder",
      windowId,
    });
    if (!confirmed) return;
    if (!windowId) windowId = useBrowser.getState().createWindow();
    useBrowser.getState().importSharedCollection(windowId, collection, spaceId);
    useBrowser.getState().setFocusedWindow(windowId);
    void focusWindow(windowId);
    showToast(windowId, "Folder Added", collection.title, { icon: "folder" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "This shared collection could not be opened.";
    if (windowId) showToast(windowId, "Cannot Add Shared Folder", message);
    else await confirm({ title: "Cannot Add Shared Folder", message, confirmTitle: "OK", cancelTitle: "Close" });
  }
}
