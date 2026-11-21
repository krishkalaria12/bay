import { confirm, prompt, showMenu } from "@bay/desktop";
import { reportBrowserCommand } from "../../runtime/commands";
import { activate, newTab, closeTab, closeTabs, updateTabDetails } from "../../runtime/tabActions";
import { pinRows, setPinnedUrl } from "../../runtime/organizeActions";
import { switchSpace, moveTabToSpace } from "../../runtime/windowActions";
import { useBrowserRead as useBrowser } from "../../store/read";
import { isIncognitoSpace, resolveWindowId, viewTabIds } from "../../store/model";
import type { Tab } from "../../store/types";
import { showToast } from "../split/splitActions";
import { openInternalPage, tabDestination } from "../pages/pageUrls";
import { libraryAvailable } from "./availability";
import { platformWords } from "../../lib/platformWords";
import type { LibraryMedia } from "./model";
import { addMediaToEasel, createEasel, deleteEasel, duplicateEasel, startLibrary, updateEasel, useLibrary } from "./state";
import { startEaselShares, stopSharingEasel, useEaselShares } from "./sharing";
import { sectionOf } from "./sections";
import { closeLibrarySidebar, librarySidebarOpen, showLibrarySidebar, useLibrarySidebar } from "./sidebarState";

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
    showToast(id, "Open Library in a Regular Window", `Library and Easels are saved on ${platformWords.thisComputer}.`, { icon: "books.vertical" });

    return null;
  }

  return id;
}

// The sidebar shows it where it can (Settings › General › Open Library in): a window with its tabs in a sidebar
// that's open. Elsewhere, and when chosen, it's a page.
function libraryFitsSidebar(windowId: string): boolean {
  const s = useBrowser.getState();
  const w = s.windows[windowId];

  return !!w && s.settings.libraryIn !== "page" && w.sidebarOpen && (w.tabLayout ?? s.settings.tabLayout) === "sidebar";
}

export function openLibrary(windowId?: string | null, section?: string) {
  const id = libraryWindow(windowId);

  if (!id) return;

  if (libraryFitsSidebar(id)) {
    startLibrary();
    showLibrarySidebar(id, section ? sectionOf(section) : (useLibrarySidebar.getState()[id] ?? "media"));
  } else openLibraryPage(id, section);
}

export function openLibraryPage(windowId?: string | null, section?: string) {
  const id = libraryWindow(windowId);

  if (!id) return;
  closeLibrarySidebar(id);
  startLibrary();
  openInternalPage("library", id, section ? { query: section } : {});
}

/** The Library button: shows the Library, or hides it from the sidebar when it's there. */
export function toggleLibrary(windowId: string) {
  if (librarySidebarOpen(windowId)) closeLibrarySidebar(windowId);
  else openLibrary(windowId);
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

export async function libraryTabMenu(windowId: string, tab: Tab) {
  if (!libraryWindow(windowId)) return;
  const s = useBrowser.getState();
  const spaces = s.spaceOrder.map((id) => s.spaces[id]).filter((space) => space && !isIncognitoSpace(space.id) && !isIncognitoSpace(space.profileId ?? ""));

  const choice = await showMenu([
    { id: "open", title: "Open Tab" },
    {
      id: "move",
      title: "Move to Space",
      children: spaces.map((space) => ({
        id: `space:${space!.id}`,
        title: space!.name,
        checked: space!.id === tab.spaceId,
        enabled: space!.id !== tab.spaceId,
      })),
    },
    { separator: true },
    { id: "close", title: "Close Tab" },
  ]);

  if (!choice || !libraryWindow(windowId)) return;
  const current = useBrowser.getState();
  const live = current.tabs[tab.id];

  if (!live || isIncognitoSpace(live.spaceId)) return;

  if (choice === "open") {
    await switchSpace(windowId, live.spaceId);
    await activate(tab.id, windowId);
  }

  if (choice.startsWith("space:")) await moveTabToSpace(tab.id, choice.slice(6));

  if (choice === "close") await closeTab(tab.id);
}
