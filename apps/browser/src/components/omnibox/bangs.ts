import { bangDocument, bangTable, checkedBangTable, findBang, joinBangTables, readBangDocument, slimBangs, type BangTable } from "@bay/core";
import { readDocument, saveDocument, writeDocument } from "@bay/shell";
import { useEffect, useSyncExternalStore } from "react";
import { fetchBangList, loadBundledBangs } from "./bangPlatform";

const LIST_DOC = "bangs.txt";
const STATE_DOC = "bangs-state.json";
const REFRESH_EVERY_MS = 86_400_000;

type RefreshState = { checkedAt: number };
export type BangRefresh = { at: number; status: number | "skipped" | "failed"; result: "updated" | "unchanged" | "failed" | "fresh" };

let table: BangTable | null = null;
let tableSource: "bundled" | "stored" | "fetched" | null = null;
let storedEtag: string | null = null;
let loading: Promise<BangTable> | null = null;
let refreshing: Promise<BangRefresh> | null = null;
const refreshes: BangRefresh[] = [];
const listeners = new Set<() => void>();

function setTable(next: BangTable, source: NonNullable<typeof tableSource>) {
  table = next;
  tableSource = source;
  for (const listener of listeners) listener();
}

function readState(): RefreshState | null {
  try {
    const state = JSON.parse(readDocument(STATE_DOC) ?? "null") as Partial<RefreshState> | null;
    return state && typeof state.checkedAt === "number" ? { checkedAt: state.checkedAt } : null;
  } catch {
    return null;
  }
}

function writeState(state: RefreshState) {
  try {
    writeDocument(STATE_DOC, JSON.stringify(state));
  } catch {}
}

function storedList(): { etag: string | null; table: BangTable } | null {
  try {
    return readBangDocument(readDocument(LIST_DOC));
  } catch {
    return null;
  }
}

export function loadBangs(): Promise<BangTable> {
  if (table) return Promise.resolve(table);
  return (loading ??= (async () => {
    const stored = storedList();
    if (stored) {
      if (!table) {
        storedEtag = stored.etag;
        setTable(stored.table, "stored");
      }
      return table!;
    }
    const { BANG_LIST, BANG_LIST_UNICODE } = await loadBundledBangs();
    if (!table) setTable(joinBangTables([bangTable(BANG_LIST), bangTable(BANG_LIST_UNICODE)]), "bundled");
    return table!;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  }));
}

export function bangsFor(text: string): BangTable | null {
  if (!table && mayBeBang(text)) void loadBangs().catch(() => {});
  return table;
}

const BANG_WORD = /^![^\s!]+$/;

export function mayBeBang(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes("!") || trimmed.startsWith("?")) return false;
  const words = trimmed.split(/\s+/);
  return BANG_WORD.test(words[0]!) || BANG_WORD.test(words[words.length - 1]!);
}

export const BANG_ENTER_TIMEOUT_MS = 1500;

// MARK: Instant links

/**
 * ⇧↩ on a search (Arc's Instant Links): straight to the search's first result, through DuckDuckGo's "\" (I'm Feeling
 * Ducky) redirect: no results page shows, and no model is asked. Null for a row that isn't
 * a plain search: an address, a page, a search shortcut ("!yt cats", "Search YouTube").
 */
export function topResultUrl(s: { kind: string; query?: string; bang?: true } | undefined): string | null {
  const query = s?.kind === "search" && !s.bang ? s.query?.trim() : "";
  return query ? `https://duckduckgo.com/?q=${encodeURIComponent(`\\${query}`)}` : null;
}

export type BangSubmitter = { submit(text: string, commit: (url: string | null) => void): void; cancel(): void };

export function createBangSubmitter(load: () => Promise<BangTable> = loadBangs, timeoutMs = BANG_ENTER_TIMEOUT_MS): BangSubmitter {
  let current = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    current++;
    clearTimeout(timer);
  };
  return {
    cancel,
    submit(text, commit) {
      cancel();
      const mine = current;
      const finish = (url: string | null) => {
        if (mine !== current) return;
        cancel();
        commit(url);
      };
      timer = setTimeout(() => finish(null), timeoutMs);
      let loaded: Promise<BangTable>;
      try {
        loaded = load();
      } catch {
        return finish(null);
      }
      loaded.then(
        (table) => finish(findBang(text, table)?.url ?? null),
        () => finish(null),
      );
    },
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const currentTable = () => table;

export function useBangs(typed: boolean): BangTable | null {
  const current = useSyncExternalStore(subscribe, currentTable);
  useEffect(() => {
    if (!typed) return;
    void loadBangs().catch(() => {});
    void refreshBangsOnce();
  }, [typed]);
  return typed ? current : null;
}

export function refreshBangsOnce(): Promise<BangRefresh> {
  return (refreshing ??= refreshBangs());
}

export async function refreshBangs(): Promise<BangRefresh> {
  const now = Date.now();
  const note = (status: BangRefresh["status"], result: BangRefresh["result"]): BangRefresh => {
    const entry = { at: now, status, result };
    refreshes.push(entry);
    return entry;
  };
  const stored = readState();
  if (stored && now >= stored.checkedAt && now - stored.checkedAt < REFRESH_EVERY_MS) return note("skipped", "fresh");
  try {
    await loadBangs();
    const etag = tableSource === "bundled" ? (await loadBundledBangs()).BANG_LIST_ETAG : storedEtag;
    const request = fetchBangList(etag);
    writeState({ checkedAt: now });
    const reply = await request;
    if (reply.status === 304) return note(304, "unchanged");
    if (reply.status !== 200 || !reply.body || !/json/i.test(reply.contentType ?? "")) return note(reply.status, "failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const slim = slimBangs(reply.body);
    const next = slim && checkedBangTable(slim);
    if (!slim || !next) return note(reply.status, "failed");
    await saveDocument(LIST_DOC, bangDocument(reply.etag, slim));
    storedEtag = reply.etag;
    setTable(next, "fetched");
    return note(reply.status, "updated");
  } catch {
    return note("failed", "failed");
  }
}

export const bangStatus = () => ({
  loaded: !!table,
  source: tableSource,
  size: table?.size ?? 0,
  etag: storedEtag,
  refreshes: refreshes.slice(),
  state: readState(),
});

export function resetBangsForTests() {
  table = null;
  tableSource = null;
  storedEtag = null;
  loading = null;
  refreshing = null;
  refreshes.length = 0;
}
