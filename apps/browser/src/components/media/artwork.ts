import { useEffect } from "react";
import { create } from "zustand";
import { askArtwork, forgetTab } from "../../lib/enrichmentService";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { ARTWORK_CACHE_ENTRIES } from "./constants";

// Keep artwork in memory only; incognito images must not reach disk or another context.
//
// The fetching is the enrichment service's work: it is asked once for an artwork that is on its way, and an
// artwork that comes back for a tab that has gone is dropped. What is here is the cache of what came back.
type Entry = { uri: string | null; at: number };

const useArtworks = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));

const keyOf = (tabId: string, url: string) => `${tabId} ${url}`;

export function useArtwork(tabId: string, url: string | null | undefined): string | null {
  const uri = useArtworks((s) => (url ? (s.entries[keyOf(tabId, url)]?.uri ?? null) : null));
  useEffect(() => {
    if (!url) return;

    // An artwork that is already here is not fetched again.
    if (useArtworks.getState().entries[keyOf(tabId, url)]) return;

    // A tab with no page of its own has no artwork to fetch.
    if (!webviews.get(tabId)) return;

    const key = keyOf(tabId, url);

    askArtwork({
      tabId,
      url,
      onArtwork: (found) => {
        useArtworks.setState((s) => {
          const entries = { ...s.entries, [key]: { uri: found, at: Date.now() } };
          const keys = Object.keys(entries).sort((a, b) => entries[a]!.at - entries[b]!.at);

          for (const old of keys.slice(0, Math.max(0, keys.length - ARTWORK_CACHE_ENTRIES))) delete entries[old];

          return { entries };
        });
      },
    });
  }, [tabId, url]);

  return uri;
}

useBrowser.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const entries = useArtworks.getState().entries;
  const gone = Object.keys(entries).filter((key) => !s.tabs[key.slice(0, key.indexOf(" "))]);

  if (!gone.length) return;
  const next = { ...entries };

  for (const key of gone) delete next[key];
  useArtworks.setState({ entries: next });

  // The artwork that was on its way is not the tab's any more.
  for (const key of gone) forgetTab(key.slice(0, key.indexOf(" ")));
});
