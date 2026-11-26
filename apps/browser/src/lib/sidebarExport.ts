import { childFolderIds, folderTabIds } from "../store/folders";
import type { BrowserProjection, DeepReadonly } from "../runtime/projection";
import { listIds, spaceListKey } from "../store/model";
import type { Tab } from "../store/types";

// Sidebar export (a space's menu › Export Pinned Tabs): a space's Essentials, pinned tabs and folders, as a bookmarks
// file any browser imports (Netscape bookmarks HTML) or as JSON. Folders nest as they do in the sidebar.

type ExportState = Pick<BrowserProjection, "spaces" | "tabs" | "tabLists" | "pinnedFolders">;

export type ExportedItem = { kind: "link"; title: string; url: string } | { kind: "folder"; title: string; items: ExportedItem[] };

export type ExportedSpace = { name: string; essentials: ExportedItem[]; pinned: ExportedItem[] };

const pageUrl = (t: DeepReadonly<Tab>) => t.pinnedUrl || t.url;

const link = (t: DeepReadonly<Tab>): ExportedItem[] =>
  /^(https?|file):/i.test(pageUrl(t)) ? [{ kind: "link", title: t.customTitle || t.title || pageUrl(t), url: pageUrl(t) }] : [];

function folderItems(s: ExportState, folderId: string, spaceId: string, depth: number): ExportedItem[] {
  const folder = s.pinnedFolders[folderId];

  if (!folder || depth > 16) return [];
  const children = childFolderIds(s, folderId, spaceId).flatMap((id) => folderItems(s, id, spaceId, depth + 1));
  const rows = folderTabIds(s, folderId, false).flatMap((id) => (s.tabs[id] ? link(s.tabs[id]) : []));

  return [{ kind: "folder", title: folder.name || "Folder", items: [...children, ...rows] }];
}

/** One space's pinned things, in sidebar order. */
export function exportedSpace(s: ExportState, spaceId: string): ExportedSpace {
  const tabs = listIds(s, spaceListKey(s, spaceId)).flatMap((id) => {
    const t = s.tabs[id];

    return t && t.spaceId === spaceId ? [t] : [];
  });

  return {
    name: s.spaces[spaceId]?.name ?? "Space",
    essentials: tabs.filter((t) => t.pinned).flatMap(link),
    pinned: [
      ...childFolderIds(s, null, spaceId).flatMap((id) => folderItems(s, id, spaceId, 0)),
      ...tabs.filter((t) => t.pinnedRow && !t.folderId).flatMap(link),
    ],
  };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlItems(items: ExportedItem[], indent: string): string {
  return items
    .map((item) =>
      item.kind === "link"
        ? `${indent}<DT><A HREF="${escape(item.url)}">${escape(item.title)}</A>\n`
        : `${indent}<DT><H3>${escape(item.title)}</H3>\n${indent}<DL><p>\n${htmlItems(item.items, `${indent}    `)}${indent}</DL><p>\n`,
    )
    .join("");
}

/** Netscape bookmarks HTML: each space a folder, its Essentials a folder inside it. */
export function bookmarksHtml(spaces: ExportedSpace[]): string {
  const folders: ExportedItem[] = spaces.map((space) => ({
    kind: "folder",
    title: space.name,
    items: [...(space.essentials.length ? [{ kind: "folder" as const, title: "Essentials", items: space.essentials }] : []), ...space.pinned],
  }));

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${htmlItems(folders, "    ")}</DL><p>
`;
}

/** The same as JSON, for scripts. */
export const bookmarksJson = (spaces: ExportedSpace[]) => `${JSON.stringify({ format: "bay-sidebar", version: 1, spaces }, null, 2)}\n`;
