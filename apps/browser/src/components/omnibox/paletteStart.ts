import { displayUrl, hostOf, parseUrl, type Suggestion } from "@bay/core";
import type { HistoryEntry, Tab } from "../../store/types";

// `host` marks a frequent site: a whole site, not one page.
export type PaletteSuggestion = Suggestion & { detail?: string; host?: string };
export type PaletteSection = { id: string; title?: string; items: PaletteSuggestion[] };

export function currentPageActions(tab: Pick<Tab, "url" | "title" | "customTitle">): PaletteSection[] {
  const title = tab.customTitle || tab.title || displayUrl(tab.url);
  return [{ id: "page", items: [
    { kind: "action", id: "copyUrl", title: "Copy Link", icon: "link", hint: "⇧⌘C", detail: displayUrl(tab.url) },
    { kind: "action", id: "copyUrlAsMarkdown", title: "Copy Markdown Link", icon: "doc.plaintext", hint: "⌥⇧⌘C", detail: `[${title}]` },
    { kind: "action", id: "duplicateTab", title: "Duplicate Tab", icon: "square.on.square" },
  ] }];
}

export function paletteStart(tabs: Tab[], history: HistoryEntry[], currentTabId: string): PaletteSection[] {
  const recent: Suggestion[] = tabs
    .filter((t) => t.id !== currentTabId && !!t.url)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 4)
    .map((t) => ({ kind: "page", tabId: t.id, url: t.url, title: t.customTitle || t.title, favicon: t.favicon }));

  const sites = new Map<string, { visits: number; lastVisit: number; page: HistoryEntry }>();
  for (const page of history) {
    if (!/^https?:\/\//i.test(page.url)) continue;
    const host = hostOf(page.url);
    if (!host) continue;
    const site = sites.get(host);
    if (!site) sites.set(host, { visits: page.visits, lastVisit: page.lastVisit, page });
    else {
      site.visits += page.visits;
      if (page.lastVisit > site.lastVisit) { site.lastVisit = page.lastVisit; site.page = page; }
    }
  }
  const frequent: PaletteSuggestion[] = [...sites.entries()]
    .sort((a, b) => b[1].visits - a[1].visits || b[1].lastVisit - a[1].lastVisit)
    .slice(0, 3)
    .map(([host, site]) => {
      const parts = parseUrl(site.page.url)!;
      return { kind: "page", title: host, host, url: `${parts.scheme}://${parts.host}${parts.port ? `:${parts.port}` : ""}/`, favicon: site.page.favicon };
    });
  return [
    ...(recent.length ? [{ id: "recent", title: "Recent Tabs", items: recent }] : []),
    ...(frequent.length ? [{ id: "frequent", title: "Frequent", items: frequent }] : []),
  ];
}
