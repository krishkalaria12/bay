import { deleteHistoryUrls, importHistoryRows } from "@bay/nncore";
import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { engineProfile, isIncognitoSpace } from "./model";
import type { HistoryEntry } from "./types";
import { MAX_HISTORY } from "./constants";

// History is Chrome's (HistoryService): Chrome records every visit itself and keeps it. `history` is the app's
// in-memory view of it, one entry per URL, newest first, filled and kept current by lib/history.ts; nothing here
// is saved. Changes go to Chrome and land in the view at once; Chrome's own report of them changes nothing more.
export type HistorySlice = {
  history: Record<string, HistoryEntry[]>;
  // Profiles whose view has been read from Chrome (until then it's empty, not "no history").
  historyReady: Record<string, true>;
  // Visits at or before this may be missing from a profile's view (it holds Chrome's newest MAX_HISTORY URLs).
  historyFloor: Record<string, number>;

  removeHistory(spaceId: string, urls: string[]): void;
  // The view only: Clear Browsing Data deletes from Chrome (clearBrowsingData's "history").
  clearHistory(spaceId: string, since?: number): void;
  importHistory(spaceId: string, entries: Omit<HistoryEntry, "favicon">[]): number;
};

export function withoutVisitsSince(entry: HistoryEntry, since: number): HistoryEntry | null {
  if (entry.lastVisit < since) return entry;
  const times = entry.visitTimes?.length ? entry.visitTimes : [entry.lastVisit];
  const kept = times.filter((t) => t < since);
  if (!kept.length) return null;
  return { ...entry, visits: entry.visits - (times.length - kept.length), lastVisit: kept[kept.length - 1]!, visitTimes: kept };
}

const failed = (what: string) => (error: unknown) => console.warn(`[history] ${what}`, error);

export const createHistorySlice: StateCreator<BrowserState, [], [], HistorySlice> = (set) => ({
  history: {},
  historyReady: {},
  historyFloor: {},

  removeHistory(spaceId, urls) {
    if (!urls.length || isIncognitoSpace(spaceId)) return;
    set((s) => ({ history: { ...s.history, [spaceId]: (s.history[spaceId] ?? []).filter((h) => !urls.includes(h.url)) } }));
    void deleteHistoryUrls(engineProfile(spaceId), urls).catch(failed("delete"));
  },

  importHistory(spaceId, entries) {
    if (isIncognitoSpace(spaceId)) return 0;
    const rows = entries.filter((e) => /^(https?|file):/.test(e.url));
    let added = 0;
    set((s) => {
      const byUrl = new Map((s.history[spaceId] ?? []).map((h) => [h.url, h]));
      for (const e of rows) {
        const existing = byUrl.get(e.url);
        if (existing) continue;
        added++;
        byUrl.set(e.url, { url: e.url, title: e.title, favicon: null, visits: Math.max(1, e.visits), lastVisit: e.lastVisit, visitTimes: [e.lastVisit] });
      }
      const merged = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, MAX_HISTORY);
      return { history: { ...s.history, [spaceId]: merged } };
    });
    void importHistoryRows(engineProfile(spaceId), rows).catch(failed("import"));
    return added;
  },

  clearHistory(spaceId, since) {
    set((s) => {
      if (since === undefined) return { history: { ...s.history, [spaceId]: [] } };
      const kept = (s.history[spaceId] ?? []).map((h) => withoutVisitsSince(h, since)).filter((h): h is HistoryEntry => !!h);
      return { history: { ...s.history, [spaceId]: kept.sort((a, b) => b.lastVisit - a.lastVisit) } };
    });
  },
});
