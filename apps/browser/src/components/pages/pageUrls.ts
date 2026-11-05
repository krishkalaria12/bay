import { focus } from "../../lib/actions";
import { useBrowser } from "../../store/browserStore";
import { activeTabId, resolveWindowId, viewTabIds } from "../../store/model";
import { INTERNAL_SCHEME, internalPageOf, tabDestination, type InternalPageId } from "./internalPages";

export * from "./internalPages";

export const internalUrl = (page: InternalPageId, query?: string) => `${INTERNAL_SCHEME}${page}${query ? `?q=${encodeURIComponent(query)}` : ""}`;

export function internalQuery(url: string): string {
  const q = /[?&]q=([^&#]*)/.exec(url)?.[1];
  try {
    return q ? decodeURIComponent(q) : "";
  } catch {
    return q ?? "";
  }
}

export function openInternalPage(page: InternalPageId, windowId?: string | null, options: { query?: string; background?: boolean } = {}) {
  const s = useBrowser.getState();
  const id = resolveWindowId(s, windowId);
  if (!id) return;
  if (!options.background && (!windowId || windowId !== id)) focus(id);
  const url = internalUrl(page, options.query);
  const existing = viewTabIds(s, id).find((t) => internalPageOf(tabDestination(s.tabs[t]!)) === page);
  if (existing) {
    if (options.query) s.navigate(existing, url);
    if (!options.background) s.activate(existing);
    return;
  }
  const active = activeTabId(s, id);
  if (active && !s.tabs[active]!.url && !options.background) return s.navigate(active, url);
  s.newTab(id, { url, background: options.background });
}
