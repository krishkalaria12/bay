import type { Tab } from "./types";

export type InternalPageId = "history" | "bookmarks" | "downloads";

export const INTERNAL_PAGES: Record<InternalPageId, { title: string }> = {
  history: { title: "History" },
  bookmarks: { title: "Bookmarks" },
  downloads: { title: "Downloads" },
};

const SCHEME = "bay://";

export const internalUrl = (page: InternalPageId, query?: string) => `${SCHEME}${page}${query ? `?q=${encodeURIComponent(query)}` : ""}`;

export function internalPageOf(url: string | null | undefined): InternalPageId | null {
  if (!url?.toLowerCase().startsWith(SCHEME)) return null;
  const page = url.slice(SCHEME.length).split(/[/?#]/)[0]!.toLowerCase();
  return page in INTERNAL_PAGES ? (page as InternalPageId) : null;
}

export function internalQuery(url: string): string {
  const q = /[?&]q=([^&#]*)/.exec(url)?.[1];
  try {
    return q ? decodeURIComponent(q) : "";
  } catch {
    return q ?? "";
  }
}

export const tabDestination = (t: Pick<Tab, "url" | "navigation">) => t.navigation?.url ?? t.url;

export const isInternalTab = (t: Pick<Tab, "url" | "navigation">) => internalPageOf(tabDestination(t)) !== null;
