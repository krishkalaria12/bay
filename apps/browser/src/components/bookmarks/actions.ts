import { modKey } from "@bay/platform";
import { confirm } from "@bay/shell";
import { create } from "zustand";
import { focus, openWindow } from "../../lib/actions";
import { folderLinks } from "../../store/bookmarks";
import { browserRead } from "../../store/read";
import { navigate, newTab } from "../../runtime/tabActions";
import { activeTabId, bookmarkSpaceId, listIds, resolveWindowId, viewTabIds, windowListKey } from "../../store/model";
import { openSplitPane } from "../../runtime/splitActions";
import { addBookmark } from "../../runtime/bookmarkActions";
import { reportBrowserCommand } from "../../runtime/commands";

export type OpenMode = "current" | "background" | "foreground" | "window" | "incognito" | "split";

export function openModeFor(e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; middle?: boolean }): OpenMode {
  if (modKey(e) || e.middle) return e.shiftKey ? "foreground" : "background";
  if (e.altKey) return "split";
  if (e.shiftKey) return "window";
  return "current";
}

export async function openUrl(url: string, windowId: string | null | undefined, mode: OpenMode) {
  const s = browserRead.getState();
  const id = resolveWindowId(s, windowId);
  if (mode === "incognito") return void (await openWindow({ incognito: true, url }));
  if (!id || mode === "window") {
    const w = id ? s.windows[id] : undefined;
    // From a private window, a new window stays private.
    const created = await openWindow(w?.incognito ? { incognito: true, url } : { url, spaceId: w?.spaceId });
    return focus(created);
  }
  const tabId = activeTabId(s, id);
  if (mode === "split") {
    if (await openSplitPane(id, { url })) return;
    return void (await newTab(id, { url }));
  }
  if (mode === "current" && tabId) return navigate(tabId, url);
  await newTab(id, { url, background: mode === "background", openerId: mode === "background" ? tabId : undefined });
}

export async function openFolder(folderId: string, windowId: string | null | undefined, mode: "tabs" | "window" | "incognito" = "tabs") {
  const s = browserRead.getState();
  const links = folderLinks(s.bookmarks, folderId);
  if (!links.length) return;
  if (links.length > 15) {
    const { confirmed } = await confirm({
      title: `Open ${links.length} tabs?`,
      message: "This folder has a lot of bookmarks.",
      confirmTitle: "Open All",
      windowId: resolveWindowId(s, windowId),
    });
    if (!confirmed) return;
  }
  const id = resolveWindowId(s, windowId);
  const source = id ? s.windows[id] : undefined;
  if (mode !== "tabs" || !id) {
    const incognito = mode === "incognito" || !!source?.incognito;
    const created = await openWindow({ url: links[0]!.url, incognito, spaceId: incognito ? undefined : source?.spaceId });
    await openInOrder(created, links.slice(1), activeTabId(browserRead.getState(), created));
    return focus(created);
  }
  const first = await newTab(id, { url: links[0]!.url });
  await openInOrder(id, links.slice(1), first);
}

// The folder's order, whatever the new-tab position setting.
async function openInOrder(windowId: string, links: { url: string }[], after: string | undefined) {
  for (const link of links) {
    const s = browserRead.getState();
    const w = s.windows[windowId];
    const tabIds = w ? listIds(s, windowListKey(s, w)) : [];
    const index = after && tabIds.includes(after) ? tabIds.indexOf(after) + 1 : undefined;
    after = (await newTab(windowId, { url: link.url, background: true, index })) || after;
  }
}

export type BookmarkDialogState =
  | { kind: "page"; windowId: string; bookmarkId: string }
  | { kind: "allTabs"; windowId: string; spaceId: string; tabs: { url: string; title: string }[] };

export const useBookmarkDialog = create<{ open: BookmarkDialogState | null; set(open: BookmarkDialogState | null): void }>((set) => ({
  open: null,
  set: (open) => set({ open }),
}));

export function bookmarkActivePage(windowId: string | null | undefined) {
  const s = browserRead.getState();
  const id = resolveWindowId(s, windowId);
  const tabId = id ? activeTabId(s, id) : undefined;
  if (id && tabId) reportBrowserCommand(bookmarkTab(id, tabId));
}

export async function bookmarkTab(windowId: string, tabId: string) {
  const s = browserRead.getState();
  const tab = s.tabs[tabId];
  if (!s.windows[windowId] || !tab?.url) return;
  const spaceId = bookmarkSpaceId(s, s.windows[windowId]);
  const roots = s.bookmarks.roots[spaceId];
  const existing = Object.values(s.bookmarks.nodes).find((n) => n.kind === "url" && n.url === tab.url && roots && isUnder(n.id, [roots.bar, roots.other]));
  const bookmarkId = existing?.id ?? (await addBookmark({ spaceId, url: tab.url, title: tab.customTitle || tab.title || tab.url, favicon: tab.favicon }));
  useBookmarkDialog.getState().set({ kind: "page", windowId, bookmarkId });
}

export function bookmarkAllTabs(windowId: string | null | undefined) {
  const s = browserRead.getState();
  const id = resolveWindowId(s, windowId);
  if (!id) return;
  const tabs = viewTabIds(s, id)
    .map((t) => s.tabs[t]!)
    .filter((t) => /^(https?|file):/.test(t.url))
    .map((t) => ({ url: t.url, title: t.customTitle || t.title || t.url }));
  if (!tabs.length) return;
  useBookmarkDialog.getState().set({ kind: "allTabs", windowId: id, spaceId: bookmarkSpaceId(s, s.windows[id]), tabs });
}

function isUnder(id: string, roots: string[]): boolean {
  const { nodes } = browserRead.getState().bookmarks;
  let node = nodes[id];
  for (let i = 0; node && i < 64; i++) {
    if (roots.includes(node.id)) return true;
    node = node.parentId ? nodes[node.parentId] : undefined;
  }
  return false;
}
