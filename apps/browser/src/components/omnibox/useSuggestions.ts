import {
  buildSuggestions,
  findBang,
  customBangTable,
  joinBangTables,
  createCurrencyConverter,
  createSuggestFetcher,
  engineById,
  findScope,
  hostOf,
  prepareSuggestions,
  parseCurrency,
  type CurrencyAnswer,
  type SearchEngine,
  type SearchScope,
  type SuggestionResult,
} from "@bay/core";
import { useEffect, useMemo, useState } from "react";
import { bookmarksByUrl } from "../../store/bookmarks";
import { useBrowser, type BrowserState } from "../../store/browser";
import { bookmarkSpaceId } from "../../store/model";
import { cleanedTabsFor } from "../../store/organize";
import { defaultSearchEngine, searchEngines } from "../../store/settings";
import type { Bookmarks, ClosedTab, HistoryEntry } from "../../store/types";
import { currentBarActions } from "./actions";
import { mayBeBang, useBangs } from "./bangs";
import { NO_HISTORY } from "../../store/constants";
import { SUGGEST_WARM_SLICE_MS } from "./constants";

const NO_REMOTE: string[] = [];
const EMPTY: SuggestionResult = { items: [], completion: "" };

type BookmarkRow = { url: string; title: string; favicon: string | null };
const bookmarkCache = new WeakMap<Bookmarks, Map<string, BookmarkRow[]>>();

function profileBookmarks(b: Bookmarks, spaceId: string): BookmarkRow[] {
  let perProfile = bookmarkCache.get(b);
  if (!perProfile) bookmarkCache.set(b, (perProfile = new Map()));
  let rows = perProfile.get(spaceId);
  if (!rows) {
    rows = [];
    for (const [url, ids] of bookmarksByUrl(b, spaceId)) {
      const node = b.nodes[ids[0]!];
      if (node?.kind === "url") rows.push({ url, title: node.title, favicon: node.favicon });
    }
    perProfile.set(spaceId, rows);
  }
  return rows;
}

type CleanedRow = { id: string; url: string; title: string; favicon: string | null; closedAt: number };
const cleanedCache = new WeakMap<ClosedTab[], Map<string, CleanedRow[]>>();

// The space's cleaned up tabs (Arc's archive), newest first, for the bar to find and restore.
function spaceCleaned(list: ClosedTab[], spaceId: string): CleanedRow[] {
  let perSpace = cleanedCache.get(list);
  if (!perSpace) cleanedCache.set(list, (perSpace = new Map()));
  let rows = perSpace.get(spaceId);
  if (!rows) {
    rows = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const { id, tab, closedAt } = list[i]!;
      if (tab.spaceId === spaceId && tab.url) rows.push({ id, url: tab.url, title: tab.customTitle || tab.title, favicon: tab.favicon, closedAt });
    }
    perSpace.set(spaceId, rows);
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

function knownHosts(s: BrowserState, spaceId: string): string[] {
  const hosts: string[] = [];
  for (const t of Object.values(s.tabs)) if (t.spaceId === spaceId && t.url) hosts.push(hostOf(t.url));
  return hosts.concat(historyHosts(s.history[spaceId] ?? NO_HISTORY));
}

export function scopeFor(text: string, windowId: string): SearchScope | null {
  const s = useBrowser.getState();
  const spaceId = s.windows[windowId]?.spaceId ?? "";
  return findScope(text, { engines: searchEngines(s.settings), hosts: knownHosts(s, spaceId) });
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
  spaceId,
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
  spaceId: string;
  currentTabId?: string;
  currentUrl?: string;
  scope: SearchScope | null;
  limit?: number;
  remoteLimit?: number;
  remoteFirst?: boolean;
}): SuggestionResult {
  const allTabs = useBrowser((s) => s.tabs);
  const history = useBrowser((s) => s.history[spaceId] ?? NO_HISTORY);
  const bookmarks = useBrowser((s) => s.bookmarks);
  const cleanedTabs = useBrowser((s) => cleanedTabsFor(s, windowId));
  const bookmarkProfile = useBrowser((s) => bookmarkSpaceId(s, s.windows[windowId]));
  const engines = useBrowser((s) => searchEngines(s.settings));
  const engine = useBrowser((s) => defaultSearchEngine(s.settings));
  const preference = useBrowser((s) => s.settings.commandBarPreference);
  const suggestionsOn = useBrowser((s) => s.settings.searchSuggestions);
  const calculatorEnabled = useBrowser((s) => s.settings.calculatorEnabled);
  const bangsEnabled = useBrowser((s) => s.settings.searchShortcutMode === "duckduckgo");

  const tabs = Object.values(allTabs).filter((t) => t.spaceId === spaceId);
  const bookmarkRows = profileBookmarks(bookmarks, bookmarkProfile);
  const source = { tabs, history, bookmarks: bookmarkRows, cleaned: spaceCleaned(cleanedTabs, spaceId) };

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
  const [currency, setCurrency] = useState<CurrencyAnswer | null>(null);
  const [convertCurrency] = useState(() => createCurrencyConverter({ fetch: (url, init) => fetch(url, init) }));
  useEffect(() => {
    if (!active || !calculatorEnabled || scope || !parseCurrency(query)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void convertCurrency(query).then((answer) => {
        if (!cancelled) setCurrency(answer);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, calculatorEnabled, scope, query, convertCurrency]);
  const bundledBangs = useBangs(active && bangsEnabled && !scope && query.includes("!"));
  const customBangs = useMemo(() => customBangTable(engines.filter((e) => e.custom)), [engines]);
  const bangs = useMemo(
    () => (bangsEnabled ? joinBangTables(bundledBangs ? [customBangs, bundledBangs] : [customBangs]) : null),
    [bangsEnabled, customBangs, bundledBangs],
  );
  const bang = useMemo(() => (bangs ? findBang(query, bangs) : null), [bangs, query]);
  const pendingBang = bangsEnabled && !bundledBangs && mayBeBang(query);
  const fromEngine = suggestEngine(scope, engines, engine);
  useEffect(() => {
    const q = query.replace(/^\?/, "").trim();
    if (!active || !suggestionsOn || !q || /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || scope?.kind === "history" || bang || (!scope && pendingBang)) {
      fetcher.cancel();
      return;
    }
    fetcher.request(fromEngine, q, (list) => setRemote({ text: query, list }));
  }, [active, suggestionsOn, query, bang, pendingBang, fromEngine, scope, fetcher]);
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
    currency,
    calculatorEnabled,
    bangs,
  });
}
