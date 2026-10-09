import type { Suggestion } from "@bay/core";
import { useBrowser } from "../../store/browser";
import type { HistoryEntry } from "../../store/types";
import { NO_HISTORY } from "../../store/constants";
import { DROPDOWN_RECENT_PAGES } from "./constants";

const pageKey = (url: string) => url.replace(/#.*$/, "");

// The pages visited last, other than the current one.
function recentPages(history: HistoryEntry[], url: string): Suggestion[] {
  const seen = new Set(url ? [pageKey(url)] : []);
  const out: Suggestion[] = [];
  for (const h of [...history].sort((a, b) => b.lastVisit - a.lastVisit)) {
    const key = pageKey(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "page", url: h.url, title: h.title, favicon: h.favicon, visited: true });
    if (out.length === DROPDOWN_RECENT_PAGES) break;
  }
  return out;
}

export function useDropdownStart(enabled: boolean, tabId: string, profileId: string): Suggestion[] {
  const url = useBrowser((s) => (enabled ? (s.tabs[tabId]?.url ?? "") : ""));
  const title = useBrowser((s) => (enabled ? (s.tabs[tabId]?.title ?? "") : ""));
  const favicon = useBrowser((s) => (enabled ? (s.tabs[tabId]?.favicon ?? null) : null));
  const history = useBrowser((s) => (enabled ? (s.history[profileId] ?? NO_HISTORY) : NO_HISTORY));
  const recent = recentPages(history, url);
  return url ? [{ kind: "page" as const, url, title, favicon }, ...recent] : recent;
}
