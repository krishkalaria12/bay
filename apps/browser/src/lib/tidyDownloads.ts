import { create } from "zustand";
import { useEffect } from "react";
import { isUserNamedDownload, tidyDownloadName, tidyNameFor, type TidyName } from "@bay/core";
import { renameFile, tidyNames } from "@bay/shell";
import { onDownload } from "@bay/nncore";
import type { Download } from "@bay/nncore";
import { showToast } from "../components/layout/splitActions";
import { downloadsIn } from "../store/ui";
import { engineProfileFor } from "../store/model";
import type { BrowserStore } from "../store/browser";
import { browserRead } from "../store/read";
import type { BrowserProjection } from "../runtime/projection";
import { dispatchBrowserCommand } from "../runtime/commands";
import { isInternalTab } from "../components/pages/urls";

// MARK: Page context

function stripHash(url: string): string {
  return url.split("#")[0] ?? "";
}

function sameDocument(a: string, b: string): boolean {
  const x = stripHash(a).replace(/\/$/, "");
  const y = stripHash(b).replace(/\/$/, "");
  return x === y;
}

export function pageForDownload(d: Download, s: BrowserProjection = browserRead.getState()): { title?: string; url?: string } {
  const urls = [d.tabUrl, d.referrer].filter((u): u is string => !!u && u !== d.url);
  if (!urls.length) return {};
  const tabs = Object.values(s.tabs).filter(
    (t) => t.url && urls.some((u) => sameDocument(t.url, u)) && t.title && !isInternalTab({ url: t.url, navigation: t.navigation }),
  );
  const windows = s.windowOrder.filter((id) => downloadsIn(s, id).some((x) => x.id === d.id));
  const preferred = tabs.find((t) => windows.includes(t.windowId));
  const tab = preferred ?? tabs[0];
  if (tab) return { title: tab.title, url: tab.url };
  const profile = d.profile ?? "";
  for (const spaceId of s.spaceOrder) {
    if (engineProfileFor(spaceId, s.spaces) !== profile) continue;
    const entries = s.history[spaceId] ?? [];
    const entry = entries.find((h) => urls.some((u) => sameDocument(h.url, u)) && h.title);
    if (entry) return { title: entry.title, url: entry.url };
  }
  for (const spaceId of Object.keys(s.history)) {
    const entries = s.history[spaceId] ?? [];
    const entry = entries.find((h) => urls.some((u) => sameDocument(h.url, u)) && h.title);
    if (entry) return { title: entry.title, url: entry.url };
  }
  return {};
}

export function windowForDownload(s: BrowserProjection, d: Download): string | null {
  const focused = s.ui.focusedWindowId;
  if (focused && downloadsIn(s, focused).some((x) => x.id === d.id)) return focused;
  return s.windowOrder.find((id) => downloadsIn(s, id).some((x) => x.id === d.id)) ?? null;
}

// MARK: Suggestion store

type TidyEntry = { filename: string; value: TidyName | null };
export const useTidyNames = create<{ entries: Record<string, TidyEntry> }>(() => ({ entries: {} }));

// In-flight suggestions, so the offer and a row asking at once share one answer.
const resolving = new Map<string, Promise<TidyName | null>>();

export function resolveTidySuggestion(d: Download, s: BrowserProjection = browserRead.getState(), store?: BrowserStore): Promise<TidyName | null> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return Promise.resolve(null);
  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return Promise.resolve(null);
  const existing = useTidyNames.getState().entries[d.id];
  if (existing && existing.filename === d.filename) return Promise.resolve(existing.value);
  const key = `${d.id}\n${d.filename}`;
  const pending = resolving.get(key);
  if (pending) return pending;
  const next = suggest(d, s, store).finally(() => resolving.delete(key));
  resolving.set(key, next);
  return next;
}

async function suggest(d: Download, s: BrowserProjection, store?: BrowserStore): Promise<TidyName | null> {
  const page = pageForDownload(d, s);
  const heuristic = tidyDownloadName({
    filename: d.filename,
    pageTitle: page.title,
    pageUrl: page.url ?? d.tabUrl ?? d.referrer,
    mimeType: d.mimeType,
  });
  let result = heuristic;
  if (heuristic && tidyNames) {
    const refined = await tidyNames.suggest(d.filename, page.title ?? "", page.url ?? d.tabUrl ?? d.referrer ?? "", heuristic.stem);
    if (refined) {
      const candidate = tidyNameFor(refined, d.filename, "page");
      if (candidate) result = candidate;
    }
  }
  const current = (store ?? browserRead).getState().downloads.find((x) => x.id === d.id);
  if (!current || current.filename !== d.filename) return null;
  useTidyNames.setState((state) => ({
    entries: { ...state.entries, [d.id]: { filename: d.filename, value: result } },
  }));
  return result;
}

export function useTidySuggestion(d: Download | undefined): TidyName | null {
  const id = d?.id ?? "";
  const entry = useTidyNames((s) => (id ? s.entries[id] : undefined));
  useEffect(() => {
    if (d) void resolveTidySuggestion(d);
  }, [d?.id, d?.filename, d?.state]);
  if (!d) return null;
  if (!entry || entry.filename !== d.filename) return null;
  return entry.value;
}

// MARK: Applying

async function updateDownloadFile(id: string, patch: { filename: string; path: string }, store?: BrowserStore) {
  if (store) store.getState().updateDownloadFile(id, patch);
  else await dispatchBrowserCommand({ method: "updateDownloadFile", id, patch });
}

// The name renameFile settled on, which gains " (1)" when the suggestion was taken.
const baseName = (path: string) => path.split("/").pop() ?? path;

export async function applyTidyName(d: Download, suggestion: TidyName, store?: BrowserStore): Promise<string | null> {
  if (d.state !== "finished" || !d.path) return null;
  const path = await renameFile(d.path, suggestion.filename);
  if (!path) return null;
  await updateDownloadFile(d.id, { filename: baseName(path), path }, store);
  return path;
}

export async function tidyRename(d: Download, suggestion: TidyName, windowId: string, store?: BrowserStore): Promise<void> {
  const original = { filename: d.filename, path: d.path };
  const path = await applyTidyName(d, suggestion, store);
  if (!path) {
    showToast(windowId, "Couldn’t Rename the Download", "The name may already be in use.", { icon: "exclamationmark.triangle" });
    return;
  }
  const renamed = (store ?? browserRead).getState().downloads.find((x) => x.id === d.id) ?? { ...d, filename: baseName(path), path };
  showToast(windowId, "Tidy Download", `Renamed to “${renamed.filename}”`, {
    icon: "wand.and.stars",
    key: `tidy-undo:${d.id}`,
    duration: 6000,
    action: { title: "Undo", run: () => void undoTidyName(renamed, original, windowId, store) },
  });
}

async function undoTidyName(d: Download, original: { filename: string; path: string }, windowId: string, store?: BrowserStore) {
  const path = await renameFile(d.path, original.filename);
  if (!path) {
    showToast(windowId, "Couldn’t Undo", "The original name is no longer available.", { icon: "exclamationmark.triangle" });
    return;
  }
  await updateDownloadFile(d.id, { filename: baseName(path), path }, store);
}

// MARK: Offering

const offered = new Set<string>();

export async function offerTidyName(d: Download, s: BrowserProjection = browserRead.getState(), store?: BrowserStore): Promise<void> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return;
  if (offered.has(d.id)) return;
  offered.add(d.id);
  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return;
  const windowId = windowForDownload(s, d);
  if (!windowId) return;
  const suggestion = await resolveTidySuggestion(d, s, store);
  const current = (store ?? browserRead).getState().downloads.find((x) => x.id === d.id);
  if (!current || current.filename !== d.filename || !suggestion) return;
  showToast(windowId, "Tidy Downloads", `Rename to “${suggestion.filename}”?`, {
    icon: "wand.and.stars",
    key: `tidy:${d.id}`,
    duration: 8000,
    action: { title: "Rename", run: () => void tidyRename(current, suggestion, windowId, store) },
  });
}

export function startTidyDownloadOffers(store: BrowserStore): () => void {
  // Only downloads that finish while Bay watches: the engine replays its finished history at every launch.
  const live = new Set<string>();
  const subscription = onDownload((d) => {
    if (d.state === "downloading") live.add(d.id);
    else if (live.delete(d.id) && d.state === "finished") void offerTidyName(d, store.getState(), store);
  });
  return () => subscription.remove();
}
