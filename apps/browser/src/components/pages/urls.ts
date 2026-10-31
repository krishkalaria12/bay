import { focus } from "../../lib/actions";
import { browserRead } from "../../store/read";
import { activate, navigate, newTab } from "../../runtime/tabActions";
import { activeTabId, resolveWindowId, viewTabIds } from "../../store/model";

export { INTERNAL_PAGES, internalUrl, internalPageOf, internalQuery, tabDestination, isInternalTab, type InternalPageId } from "../../store/internalPages";
import { internalUrl, internalPageOf, tabDestination, type InternalPageId } from "../../store/internalPages";

export async function openInternalPage(page: InternalPageId, windowId?: string | null, options: { query?: string; background?: boolean } = {}) {
  const s = browserRead.getState();
  const id = resolveWindowId(s, windowId);
  if (!id) return;
  if (!options.background && (!windowId || windowId !== id)) focus(id);
  const url = internalUrl(page, options.query);
  const existing = viewTabIds(s, id).find((t) => internalPageOf(tabDestination(s.tabs[t]!)) === page);
  if (existing) {
    if (options.query) await navigate(existing, url);
    if (!options.background) await activate(existing);
    return;
  }
  const active = activeTabId(s, id);
  if (active && !s.tabs[active]!.url && !options.background) return navigate(active, url);
  await newTab(id, { url, background: options.background });
}
