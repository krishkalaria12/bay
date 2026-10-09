import {
  buildSuggestions,
  createSuggestFetcher,
  engineById,
  findScope,
  hostOf,
  prepareSuggestions,
  type SearchEngine,
  type SearchScope,
  type SuggestionResult,
} from "@bay/core";
import { useEffect, useState } from "react";
import { bookmarksByUrl } from "../../store/bookmarks";
import { useBrowser, type BrowserState } from "../../store/browser";
import { bookmarkProfileId } from "../../store/model";
import { defaultSearchEngine, searchEngines } from "../../store/settings";
import type { Bookmarks, HistoryEntry } from "../../store/types";
import { currentBarActions } from "./actions";
import { NO_HISTORY } from "../../store/constants";
import { SUGGEST_WARM_SLICE_MS } from "./constants";

const NO_REMOTE: string[] = [];
const EMPTY: SuggestionResult = { items: [], completion: "" };

type BookmarkRow = { url: string; title: string; favicon: string | null };
const bookmarkCache = new WeakMap<Bookmarks, Map<string, BookmarkRow[]>>();

function profileBookmarks(b: Bookmarks, profileId: string): BookmarkRow[] {
  let perProfile = bookmarkCache.get(b);
  if (!perProfile) bookmarkCache.set(b, (perProfile = new Map()));
  let rows = perProfile.get(profileId);
  if (!rows) {
    rows = [];
    for (const [url, ids] of bookmarksByUrl(b, profileId)) {
      const node = b.nodes[ids[0]!];
      if (node?.kind === "url") rows.push({ url, title: node.title, favicon: node.favicon });
    }
    perProfile.set(profileId, rows);
  }
  return rows;
}

const historyHostCache = new WeakMap<HistoryEntry[], string[]>();

function historyHosts(history: HistoryEntry[]): string[] {
  let hosts = historyHostCache.get(history);
  if (!hosts) {
    const set = new Set<string>();
    for (const h of history) set.add(hostOf(h.url));
    set.delete("");
    historyHostCache.set(history, (hosts = [...set]));
  }
  return hosts;
}

function knownHosts(s: BrowserState, profileId: string): string[] {
  const hosts: string[] = [];
  for (const t of Object.values(s.tabs)) if (t.profileId === profileId && t.url) hosts.push(hostOf(t.url));
  return hosts.concat(historyHosts(s.history[profileId] ?? NO_HISTORY));
}

export function scopeFor(text: string, windowId: string): SearchScope | null {
  const s = useBrowser.getState();
  const profileId = s.windows[windowId]?.profileId ?? "";
  return findScope(text, { engines: searchEngines(s.settings), hosts: knownHosts(s, profileId) });
}

function suggestEngine(scope: SearchScope | null, engines: SearchEngine[], fallback: SearchEngine): SearchEngine {
  return scope?.kind === "engine" ? engineById(engines, scope.engineId) : fallback;
}

// The engine's suggestions for `query`: those for an earlier prefix of it narrow down while the request is out.
function remoteFor(remote: { text: string; list: string[] }, query: string): string[] {
  if (remote.text === query) return remote.list;
  const q = query.toLowerCase();
  if (!remote.text || !q.startsWith(remote.text.toLowerCase())) return NO_REMOTE;
  return remote.list.filter((s) => s.toLowerCase().startsWith(q));
}

export function useSuggestions({
  text,
  active,
  windowId,
  profileId,
  currentTabId,
  currentUrl,
  scope,
  limit,
  remoteLimit,
  remoteFirst,
}: {
  text: string;
  active: boolean;
  windowId: string;
  profileId: string;
  currentTabId?: string;
  currentUrl?: string;
  scope: SearchScope | null;
  limit?: number;
  remoteLimit?: number;
  remoteFirst?: boolean;
}): SuggestionResult {
  const allTabs = useBrowser((s) => s.tabs);
  const history = useBrowser((s) => s.history[profileId] ?? NO_HISTORY);
  const bookmarks = useBrowser((s) => s.bookmarks);
  const bookmarkProfile = useBrowser((s) => bookmarkProfileId(s, s.windows[windowId]));
  const engines = useBrowser((s) => searchEngines(s.settings));
  const engine = useBrowser((s) => defaultSearchEngine(s.settings));
  const preference = useBrowser((s) => s.settings.commandBarPreference);
  const suggestionsOn = useBrowser((s) => s.settings.searchSuggestions);

  const tabs = Object.values(allTabs).filter((t) => t.profileId === profileId);
  const bookmarkRows = profileBookmarks(bookmarks, bookmarkProfile);
  const source = { tabs, history, bookmarks: bookmarkRows };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      timer = prepareSuggestions(source, Date.now() + SUGGEST_WARM_SLICE_MS) ? undefined : setTimeout(step, 16);
      if (!timer) historyHosts(source.history);
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [source]);

  const [remote, setRemote] = useState<{ text: string; list: string[] }>({ text: "", list: [] });
  const [fetcher] = useState(() => createSuggestFetcher({ fetch: (url, init) => fetch(url, init) }));
  const query = text.trim();
  const fromEngine = suggestEngine(scope, engines, engine);
  useEffect(() => {
    const q = query.replace(/^\?/, "").trim();
    if (!active || !suggestionsOn || !q || /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || scope?.kind === "history") {
      fetcher.cancel();
      return;
    }
    fetcher.request(fromEngine, q, (list) => setRemote({ text: query, list }));
  }, [active, suggestionsOn, query, fromEngine, scope, fetcher]);
  useEffect(() => () => fetcher.cancel(), [fetcher]);

  if (!active || !query) return EMPTY;
  return buildSuggestions(text, source, {
    engine,
    preference,
    remote: remoteFor(remote, query),
    actions: currentBarActions(windowId),
    currentTabId,
    currentUrl,
    scope,
    limit,
    remoteLimit,
    remoteFirst,
  });
}
