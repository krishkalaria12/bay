import type { Tab } from "../../store/types";

// What an internal page's address says, with nothing that needs the app running: store and lib code can read it.

export type InternalPageId = "history" | "bookmarks" | "downloads" | "library" | "easel";

export const INTERNAL_PAGES: Record<InternalPageId, { title: string }> = {
  library: { title: "Library" },
  easel: { title: "Easel" },
  history: { title: "History" },
  bookmarks: { title: "Bookmarks" },
  downloads: { title: "Downloads" },
};

export const INTERNAL_SCHEME = "bay://";

export function internalPageOf(url: string | null | undefined): InternalPageId | null {
  if (!url?.toLowerCase().startsWith(INTERNAL_SCHEME)) return null;
  const page = url.slice(INTERNAL_SCHEME.length).split(/[/?#]/)[0]!.toLowerCase();

  // SAFETY: `page in INTERNAL_PAGES` was just checked, so page names a known internal page id.
  return page in INTERNAL_PAGES ? (page as InternalPageId) : null;
}

export const tabDestination = (t: Pick<Tab, "url" | "navigation">) => t.navigation?.url ?? t.url;

export const isInternalTab = (t: Pick<Tab, "url" | "navigation">) => internalPageOf(tabDestination(t)) !== null;
