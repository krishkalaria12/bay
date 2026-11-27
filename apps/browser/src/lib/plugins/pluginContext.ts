import type { BrowserProjection } from "../../runtime/projection";
import { activeTab } from "../../store/model";
import { webOrigin } from "./protocol";

// The page a plugin's command runs on, as the plugin may see it (only with permissions.tabs, which the service
// checks): never a private window's, never Bay's own pages.

type Page = { url: string; title: string };

const page = (tab: { url: string; title: string; customTitle?: string | null } | undefined): Page | null =>
  tab && webOrigin(tab.url) ? { url: tab.url, title: tab.customTitle || tab.title || tab.url } : null;

/** The tab a command was run on (`tabId`, from the tab menu) or the window's own page. */
export function commandPage(s: BrowserProjection, windowId: string, tabId: string | null): Page | null {
  const window = s.windows[windowId];

  if (!window || window.incognito) return null;

  if (!tabId) return page(activeTab(s, windowId));
  const tab = s.tabs[tabId];

  return tab && tab.spaceId === window.spaceId ? page(tab) : null;
}

/** The front public main window: where a plugin's tab opens, and whose page is the active one. */
export function frontPublicWindow(s: BrowserProjection): string | undefined {
  const main = (id: string) => !!s.windows[id] && !s.windows[id]!.incognito && s.windows[id]!.kind !== "small";

  return s.ui.focusOrder.find(main) ?? s.windowOrder.find(main);
}

export function frontPage(s: BrowserProjection): Page | null {
  const windowId = frontPublicWindow(s);

  return windowId ? commandPage(s, windowId, null) : null;
}
