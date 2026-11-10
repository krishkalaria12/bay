import { create } from "zustand";
import { useEffect } from "react";
import { isUserNamedDownload, modelTidyName, tidyDownloadName, type TidyName } from "@bay/core";
import { renameFile, tidyNames } from "@bay/desktop";
import { onDownload } from "@bay/chromium";
import type { Download } from "@bay/chromium";
import { showToast } from "../components/ui/toasts";
import { downloadsIn } from "../store/windowUi";
import { engineProfileFor } from "../store/model";
import type { BrowserStore } from "../store/browserStore";
import { browserRead } from "../store/read";
import type { BrowserProjection } from "../runtime/projection";
import { dispatchBrowserCommand } from "../runtime/commands";
import { isInternalTab } from "../components/pages/internalPages";

// MARK: Page context

type DownloadPageContext = { title?: string; url?: string };

function stripHash(url: string): string {
  return url.split("#")[0] ?? "";
}

function sameDocument(a: string, b: string): boolean {
  const x = stripHash(a).replace(/\/$/, "");
  const y = stripHash(b).replace(/\/$/, "");

  return x === y;
}

export function pageForDownload(d: Download, s: BrowserProjection = browserRead.getState()): DownloadPageContext {
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

// What the local cleaner would call a download: instant, so every row of a long list can ask. The model is only asked
// for a download Bay is about to rename (tidyFinishedDownload), never for the list's old rows.
type TidyEntry = { filename: string; value: TidyName | null };

export const useTidyNames = create<{ entries: Record<string, TidyEntry> }>(() => ({ entries: {} }));

function cleanedName(d: Download, s: BrowserProjection): TidyName | null {
  const page = pageForDownload(d, s);

  return tidyDownloadName({
    filename: d.filename,
    pageTitle: page.title,
    pageUrl: page.url ?? d.tabUrl ?? d.referrer,
    mimeType: d.mimeType,
  });
}

export function resolveTidySuggestion(d: Download, s: BrowserProjection = browserRead.getState()): Promise<TidyName | null> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return Promise.resolve(null);

  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return Promise.resolve(null);
  const existing = useTidyNames.getState().entries[d.id];

  if (existing && existing.filename === d.filename) return Promise.resolve(existing.value);
  const value = cleanedName(d, s);
  useTidyNames.setState((state) => ({ entries: { ...state.entries, [d.id]: { filename: d.filename, value } } }));

  return Promise.resolve(value);
}

// The model's better name where it has one, the local cleaner's otherwise. Neither leaves this Mac, and only a Mac
// with Apple Intelligence has a model at all (packages/desktop): Windows and Linux keep the local cleaner's name.
async function refinedName(d: Download, s: BrowserProjection, cleaned: TidyName): Promise<TidyName> {
  if (!tidyNames) return cleaned;
  const page = pageForDownload(d, s);
  const answer = await tidyNames.suggest(d.filename, page.title ?? "", page.url ?? d.tabUrl ?? d.referrer ?? "").catch(() => null);

  return (answer && modelTidyName(answer, d.filename)) || cleaned;
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
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export async function applyTidyName(d: Download, suggestion: TidyName, store?: BrowserStore): Promise<string | null> {
  if (d.state !== "finished" || !d.path) return null;
  const path = await renameFile(d.path, suggestion.filename);

  if (!path) return null;
  await updateDownloadFile(d.id, { filename: baseName(path), path }, store);

  return path;
}

function clipped(name: string): string {
  return name.length <= 44 ? name : `${name.slice(0, 28)}…${name.slice(-15)}`;
}

function showRenamed(d: Download, original: { filename: string; path: string }, path: string, windowId: string, store?: BrowserStore) {
  const renamed = (store ?? browserRead).getState().downloads.find((x) => x.id === d.id) ?? { ...d, filename: baseName(path), path };
  showToast(windowId, `Renamed to “${renamed.filename}”`, `Was “${clipped(original.filename)}”`, {
    icon: "wand.and.stars",
    key: `tidy-undo:${d.id}`,
    duration: 8000,
    action: { title: "Undo", run: () => void undoTidyName(renamed, original, windowId, store) },
  });
}

export async function tidyRename(d: Download, suggestion: TidyName, windowId: string, store?: BrowserStore): Promise<void> {
  const original = { filename: d.filename, path: d.path };
  const path = await applyTidyName(d, suggestion, store);

  if (!path) {
    showToast(windowId, "Couldn’t Rename the Download", "The name may already be in use.", { icon: "exclamationmark.triangle" });

    return;
  }

  showRenamed(d, original, path, windowId, store);
}

async function undoTidyName(d: Download, original: { filename: string; path: string }, windowId: string, store?: BrowserStore) {
  const path = await renameFile(d.path, original.filename);

  if (!path) {
    showToast(windowId, "Couldn’t Undo", "The original name is no longer available.", { icon: "exclamationmark.triangle" });

    return;
  }

  await updateDownloadFile(d.id, { filename: baseName(path), path }, store);
  showToast(windowId, "Download Name Reverted", clipped(baseName(path)), { icon: "arrow.uturn.backward" });
}

// MARK: Renaming finished downloads

const handled = new Set<string>();

/** This download won't be renamed when it finishes. */
export const keepDownloadName = (id: string) => void handled.add(id);

/**
 * A download finished: with Tidy Downloads on it gets a readable name right away, as in Arc, and a toast with the way
 * back. Once for each download, so an undo sticks. A name a person chose, or one already readable, is left alone.
 */
export async function tidyFinishedDownload(d: Download, s: BrowserProjection = browserRead.getState(), store?: BrowserStore): Promise<void> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return;

  if (handled.has(d.id)) return;
  handled.add(d.id);

  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return;
  const windowId = windowForDownload(s, d);
  const cleaned = cleanedName(d, s);

  if (!windowId || !cleaned) return;
  const name = await refinedName(d, s, cleaned);
  // The model takes a moment: the file may have been renamed, removed or the setting turned off meanwhile.
  const now = (store ?? browserRead).getState();
  const current = now.downloads.find((x) => x.id === d.id);

  if (!now.settings.tidyDownloads || !current || current.filename !== d.filename || current.state !== "finished") return;
  const original = { filename: current.filename, path: current.path };
  const path = await applyTidyName(current, name, store);

  // Nobody asked for this rename, so a file that can't take the name just keeps its own.
  if (path) showRenamed(current, original, path, windowId, store);
}

/** Watches for downloads that finish while Bay watches, and gives them a readable name. */
export function startTidyDownloads(store?: BrowserStore): () => void {
  // Only downloads that finish while Bay watches: the engine replays its finished history at every launch.
  const live = new Set<string>();

  const subscription = onDownload((d) => {
    if (d.state === "downloading") live.add(d.id);
    else if (live.delete(d.id) && d.state === "finished") void tidyFinishedDownload(d, (store ?? browserRead).getState(), store);
  });

  return () => subscription.remove();
}
