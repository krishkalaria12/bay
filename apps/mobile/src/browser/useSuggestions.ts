import type { SearchEngine } from "@bay/core/src/engines.ts";
import { buildSuggestions, type Suggestion } from "@bay/core/src/suggest.ts";
import { createSuggestFetcher } from "@bay/core/src/suggestFetcher.ts";
import { useEffect, useMemo, useState } from "react";

import { bookmarkLinks } from "@/store/bookmarks";
import { spaceBookmarks, spaceHistory } from "@/store/model";
import type { BrowserData } from "@/store/types";

const fetcher = createSuggestFetcher({ fetch: (url, init) => fetch(url, init) });

export type Row = Extract<Suggestion, { kind: "page" | "search" | "calc" }>;

const isRow = (item: Suggestion): item is Row => item.kind === "page" || item.kind === "search" || item.kind === "calc";

/** The omnibox rows for typed text, from desktop's ranking: open tabs, history, bookmarks, archived tabs and the engine's suggestions. */
export function useSuggestions(query: string, engine: SearchEngine, data: BrowserData, currentUrl: string): { rows: Row[]; completion: string } {
  const [remote, setRemote] = useState<readonly string[]>([]);

  // With suggestions off, nothing typed leaves the device before it's sent.
  const ask = data.preferences.searchSuggestions;
  useEffect(() => {
    if (!query.trim() || !ask) {
      fetcher.cancel();
      setRemote([]);

      return;
    }

    fetcher.request(engine, query, setRemote);
  }, [engine, query, ask]);
  useEffect(() => () => fetcher.cancel(), []);

  // One list per bookmark tree: the ranking indexes a list once and keeps it while the same list comes back.
  // The space showing: its own history, bookmarks and archive, as the desktop's profile per space.
  const tree = spaceBookmarks(data, data.activeSpaceId);
  const bookmarks = useMemo(() => bookmarkLinks(tree).map((link) => ({ url: link.url, title: link.title, favicon: null })), [tree]);
  const history = useMemo(() => spaceHistory({ history: data.history }, data.activeSpaceId), [data.history, data.activeSpaceId]);

  return useMemo(() => {
    const cleaned = data.archive.filter((tab) => tab.spaceId === data.activeSpaceId);

    if (!query.trim()) {
      // Before typing: recent pages, like Lens.
      const rows = history
        .filter((entry) => entry.url !== currentUrl)
        .slice(0, 4)
        .map((entry): Row => ({ kind: "page", url: entry.url, title: entry.title, favicon: null, visited: true }));

      return { rows, completion: "" };
    }

    const result = buildSuggestions(
      query,
      { tabs: data.tabs.filter((tab) => tab.url), history, bookmarks, cleaned },
      { engine, remote, limit: 7, currentTabId: data.activeTabId, currentUrl },
    );

    return { rows: result.items.filter(isRow), completion: result.completion };
  }, [bookmarks, currentUrl, data, engine, history, query, remote]);
}
