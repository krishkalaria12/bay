import { confirm, prompt, showMenu } from "@bay/shell";
import { reportBrowserCommand } from "../../runtime/commands";
import { activate, newTab, closeTabs, updateTabDetails } from "../../runtime/tabActions";
import { pinRows, setPinnedUrl } from "../../runtime/organizeActions";
import { useBrowserRead as useBrowser } from "../../store/read";
import { resolveWindowId, viewTabIds } from "../../store/model";
import { showToast } from "../layout/splitActions";
import { openInternalPage, tabDestination } from "../pages/urls";
import { libraryAvailable } from "./availability";
import type { LibraryMedia } from "./model";
import { addMediaToEasel, createEasel, deleteEasel, duplicateEasel, startLibrary, updateEasel, useLibrary } from "./state";
import { startEaselShares, stopSharingEasel, useEaselShares } from "./sharing";

export const easelUrl = (id: string) => `bay://easel/${encodeURIComponent(id)}`;
export function easelIdOf(url: string): string | null {
  const m = /^bay:\/\/easel\/([^/?#]+)/i.exec(url);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

export function libraryWindow(windowId?: string | null): string | null {
  const s = useBrowser.getState();
  const id = resolveWindowId(s, windowId);
  if (!id) return null;
  if (!libraryAvailable()) {
    showToast(id, "Library Is Unavailable", "Library and Easels are not supported in this window yet.", { icon: "books.vertical" });
    return null;
  }
  if (s.windows[id]?.incognito) {
    showToast(id, "Open Library in a Regular Window", "Library and Easels are saved on this Mac.", { icon: "books.vertical" });
    return null;
  }
  return id;
}

export function openLibrary(windowId?: string | null, section?: string) {
  const id = libraryWindow(windowId);
  if (!id) return;
  startLibrary();
  openInternalPage("library", id, section ? { query: section } : {});
}

export function openEasel(id: string, windowId?: string | null) {
  reportBrowserCommand(openEaselTab(id, windowId));
}

async function openEaselTab(id: string, windowId?: string | null) {
  const window = libraryWindow(windowId);
  if (!window) return;
  startLibrary();
  const s = useBrowser.getState();
  const doc = useLibrary.getState().easels[id];
  if (!doc) return;
  const existing = viewTabIds(s, window).find((t) => easelIdOf(tabDestination(s.tabs[t]!)) === id);
  if (existing) {
    await activate(existing, window);
    return existing;
  }
  const tabId = await newTab(window, { url: easelUrl(id) });
  await updateTabDetails(tabId, { customTitle: doc.title });
  await pinRows([tabId], true);
  await setPinnedUrl(tabId, easelUrl(id));
  return tabId;
}

export function newEasel(windowId?: string | null) {
  const window = libraryWindow(windowId);
  if (!window) return null;
  const id = createEasel(useBrowser.getState().windows[window]!.spaceId);
  if (id) openEasel(id, window);
  else showToast(window, "Couldn't Create Easel", useLibrary.getState().error ?? undefined);
  return id;
}

export async function chooseEasel(media: LibraryMedia, windowId: string) {
  const window = libraryWindow(windowId);
  if (!window) return false;
  const docs = Object.values(useLibrary.getState().easels).sort((a, b) => b.updatedAt - a.updatedAt);
  const choice = await showMenu([
    { id: "new", title: "New Easel…" },
    ...(docs.length ? [{ separator: true as const }] : []),
    ...docs.map((d) => ({ id: d.id, title: d.title || "Untitled Easel" })),
  ]);
  if (!choice) return false;
  let id = choice;
  if (choice === "new") {
    const title = await prompt({ title: "New Easel", message: "Give your Easel a name.", value: "Untitled Easel", confirmTitle: "Create Easel" });
    if (title === null) return false;
    const created = createEasel(useBrowser.getState().windows[window]!.spaceId, title.trim() || "Untitled Easel");
    if (!created) return false;
    id = created;
  }
  if (!addMediaToEasel(id, media)) return false;
  openEasel(id, window);
  return true;
}

export async function renameEasel(id: string) {
  if (!libraryAvailable()) return;
  const doc = useLibrary.getState().easels[id];
  if (!doc) return;
  const title = await prompt({ title: "Rename Easel", value: doc.title, confirmTitle: "Rename" });
  if (title !== null && title.trim()) updateEasel(id, { title: title.trim() });
}

export async function easelMenu(id: string, windowId: string) {
  if (!libraryAvailable()) return;
  const choice = await showMenu([
    { id: "open", title: "Open Easel" },
    { id: "rename", title: "Rename…" },
    { id: "duplicate", title: "Duplicate" },
    { separator: true },
    { id: "delete", title: "Delete Easel…" },
  ]);
  if (choice === "open") openEasel(id, windowId);
  if (choice === "rename") await renameEasel(id);
  if (choice === "duplicate") {
    const copy = duplicateEasel(id);
    if (copy) openEasel(copy, windowId);
  }
  if (choice === "delete") await removeEasel(id);
}

export async function removeEasel(id: string) {
  if (!libraryAvailable()) return;
  const doc = useLibrary.getState().easels[id];
  if (!doc) return;
  startEaselShares();
  const shared = !!useEaselShares.getState().records[id];
  const { confirmed } = await confirm({
    title: `Delete “${doc.title}”?`,
    message: shared
      ? "This stops sharing the web page and removes the Easel from Library. Saved media stays in Library."
      : "This removes the Easel from Library. Saved media stays in Library.",
    confirmTitle: "Delete",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await stopSharingEasel(id);
  } catch (error) {
    showToast(resolveWindowId(useBrowser.getState()) ?? "", "Couldn't Delete Easel", error instanceof Error ? error.message : String(error));
    return;
  }
  deleteEasel(id);
  const s = useBrowser.getState();
  await closeTabs(
    Object.values(s.tabs)
      .filter((t) => easelIdOf(tabDestination(t)) === id)
      .map((t) => t.id),
  );
}
