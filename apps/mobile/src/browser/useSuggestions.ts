import type { SearchEngine } from "@bay/core/src/engines.ts";
import { buildSuggestions, type Suggestion } from "@bay/core/src/suggest.ts";
import { createSuggestFetcher } from "@bay/core/src/suggestFetcher.ts";
import { useEffect, useMemo, useState } from "react";

import type { BrowserData } from "@/store/types";

const fetcher = createSuggestFetcher({ fetch: (url, init) => fetch(url, init) });

export type Row = Extract<Suggestion, { kind: "page" | "search" | "calc" }>;

const isRow = (item: Suggestion): item is Row => item.kind === "page" || item.kind === "search" || item.kind === "calc";

/** The omnibox rows for typed text, from desktop's ranking: open tabs, history, archived tabs and the engine's suggestions. */
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

  return useMemo(() => {
    if (!query.trim()) {
      // Before typing: recent pages, like Lens.
      const rows = data.history
        .filter((entry) => entry.url !== currentUrl)
        .slice(0, 4)
        .map((entry): Row => ({ kind: "page", url: entry.url, title: entry.title, favicon: null, visited: true }));

      return { rows, completion: "" };
    }

    const result = buildSuggestions(
      query,
      { tabs: data.tabs.filter((tab) => tab.url), history: data.history, cleaned: data.archive },
      { engine, remote, limit: 7, currentTabId: data.activeTabId, currentUrl },
    );

    return { rows: result.items.filter(isRow), completion: result.completion };
  }, [currentUrl, data, engine, query, remote]);
}
