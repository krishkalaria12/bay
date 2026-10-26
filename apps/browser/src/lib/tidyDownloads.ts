import { create } from "zustand";
import { useEffect } from "react";
import { isUserNamedDownload, tidyDownloadName, tidyNameFor, type TidyName } from "@bay/core";
import { renameFile, tidyNames } from "@bay/shell";
import { onDownload } from "@bay/nncore";
import type { Download } from "@bay/nncore";
import { showToast } from "../components/layout/splitActions";
import { downloadsIn } from "../store/ui";
import { engineProfile } from "../store/model";
import { useBrowser, type BrowserState } from "../store/browser";
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

export function pageForDownload(d: Download, s: BrowserState = useBrowser.getState()): { title?: string; url?: string } {
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
    if (engineProfile(spaceId) !== profile) continue;
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

export function windowForDownload(s: BrowserState, d: Download): string | null {
  const focused = s.ui.focusedWindowId;
  if (focused && downloadsIn(s, focused).some((x) => x.id === d.id)) return focused;
  return s.windowOrder.find((id) => downloadsIn(s, id).some((x) => x.id === d.id)) ?? null;
}

// MARK: Suggestion store

type TidyEntry = { filename: string; value: TidyName | null };
export const useTidyNames = create<{ entries: Record<string, TidyEntry> }>(() => ({ entries: {} }));

const resolving = new Set<string>();

export async function resolveTidySuggestion(d: Download, s: BrowserState = useBrowser.getState()): Promise<TidyName | null> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return null;
  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return null;
  const key = d.id;
  const existing = useTidyNames.getState().entries[key];
  if (existing && existing.filename === d.filename) return existing.value;
  if (resolving.has(key)) return null;
  resolving.add(key);
  try {
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
    const current = useBrowser.getState().downloads.find((x) => x.id === d.id);
    if (!current || current.filename !== d.filename) return null;
    useTidyNames.setState((state) => ({
      entries: { ...state.entries, [d.id]: { filename: d.filename, value: result } },
    }));
    return result;
  } finally {
    resolving.delete(key);
  }
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

export async function applyTidyName(d: Download, suggestion: TidyName): Promise<string | null> {
  if (d.state !== "finished" || !d.path) return null;
  const path = await renameFile(d.path, suggestion.filename);
  if (!path) return null;
  useBrowser.getState().updateDownloadFile(d.id, { filename: suggestion.filename, path });
  return path;
}

export async function tidyRename(d: Download, suggestion: TidyName, windowId: string): Promise<void> {
  const original = { filename: d.filename, path: d.path };
  const path = await applyTidyName(d, suggestion);
  if (!path) {
    showToast(windowId, "Couldn’t Rename the Download", "The name may already be in use.", { icon: "exclamationmark.triangle" });
    return;
  }
  const renamed = useBrowser.getState().downloads.find((x) => x.id === d.id) ?? { ...d, filename: suggestion.filename, path };
  showToast(windowId, "Tidy Download", `Renamed to “${suggestion.filename}”`, {
    icon: "wand.and.stars",
    key: `tidy-undo:${d.id}`,
    duration: 6000,
    action: { title: "Undo", run: () => void undoTidyName(renamed, original, windowId) },
  });
}

async function undoTidyName(d: Download, original: { filename: string; path: string }, windowId: string) {
  const path = await renameFile(d.path, original.filename);
  if (!path) {
    showToast(windowId, "Couldn’t Undo", "The original name is no longer available.", { icon: "exclamationmark.triangle" });
    return;
  }
  useBrowser.getState().updateDownloadFile(d.id, { filename: original.filename, path });
}

// MARK: Offering

const offered = new Set<string>();

export async function offerTidyName(d: Download, s: BrowserState = useBrowser.getState()): Promise<void> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return;
  if (offered.has(d.id)) return;
  offered.add(d.id);
  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return;
  const windowId = windowForDownload(s, d);
  if (!windowId) return;
  const suggestion = await resolveTidySuggestion(d, s);
  const current = useBrowser.getState().downloads.find((x) => x.id === d.id);
  if (!current || current.filename !== d.filename || !suggestion) return;
  showToast(windowId, "Tidy Downloads", `Rename to “${suggestion.filename}”?`, {
    icon: "wand.and.stars",
    key: `tidy:${d.id}`,
    duration: 8000,
    action: { title: "Rename", run: () => void tidyRename(current, suggestion, windowId) },
  });
}

export function startTidyDownloadOffers(): void {
  onDownload((d) => {
    if (d.state === "finished") void offerTidyName(d);
  });
}
