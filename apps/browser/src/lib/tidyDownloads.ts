import { create } from "zustand";
import { useEffect } from "react";
import { isUserNamedDownload, tidyDownloadName, type TidyName } from "@bay/core";
import { onDownload } from "@bay/chromium";
import type { Download } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { showToast } from "../components/ui/toasts";
import type { BrowserStore } from "../store/browserStore";
import type { BrowserProjection as BrowserState } from "../runtime/projection";
import { useBrowserRead as useBrowser } from "../store/read";
import { hasServiceClient, requestService } from "../runtime/serviceClient";
import { runDesktop, runForStore } from "../effect/runtime";
import { DownloadWorkService, pageForDownload, windowForDownload } from "./downloadWorkService";

// The page a download came from, and the window that showed it: the model's own answers (downloadWorkService.ts).
export { pageForDownload, windowForDownload };

// MARK: Suggestion store

// What the local cleaner would call a download: instant, so every row of a long list can ask. The model is only asked
// for a download Bay is about to rename (tidyFinishedDownload), never for the list's old rows.
type TidyEntry = { filename: string; value: TidyName | null };

export const useTidyNames = create<{ entries: Record<string, TidyEntry> }>(() => ({ entries: {} }));

function cleanedName(d: Download, s: BrowserState): TidyName | null {
  const page = pageForDownload(d, s);

  return tidyDownloadName({
    filename: d.filename,
    pageTitle: page.title,
    pageUrl: page.url ?? d.tabUrl ?? d.referrer,
    mimeType: d.mimeType,
  });
}

export function resolveTidySuggestion(d: Download, s: BrowserState = useBrowser.getState()): Promise<TidyName | null> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return Promise.resolve(null);

  if (isUserNamedDownload(d.filename, d.suggestedFilename)) return Promise.resolve(null);
  const existing = useTidyNames.getState().entries[d.id];

  if (existing && existing.filename === d.filename) return Promise.resolve(existing.value);
  const value = cleanedName(d, s);
  useTidyNames.setState((state) => ({ entries: { ...state.entries, [d.id]: { filename: d.filename, value } } }));

  return Promise.resolve(value);
}

// The downloads the user named themselves, or that were already named: they are left alone.
const keptDownloads = new Set<string>();

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

const baseName = (path: string) => path.split("/").pop() ?? path;

export async function applyTidyName(d: Download, suggestion: TidyName): Promise<string | null> {
  if (hasServiceClient()) return requestService("downloadRename", [d.id, suggestion.filename]);

  return runDesktop(
    Effect.gen(function* () {
      const work = yield* DownloadWorkService;

      return yield* work.rename(d, suggestion);
    }),
  );
}

function clipped(name: string): string {
  return name.length <= 44 ? name : `${name.slice(0, 28)}…${name.slice(-15)}`;
}

function showRenamed(d: Download, original: { filename: string; path: string }, path: string, windowId: string) {
  const renamed = useBrowser.getState().downloads.find((x) => x.id === d.id) ?? { ...d, filename: baseName(path), path };
  showToast(windowId, `Renamed to “${renamed.filename}”`, `Was “${clipped(original.filename)}”`, {
    icon: "wand.and.stars",
    key: `tidy-undo:${d.id}`,
    duration: 8000,
    action: { title: "Undo", run: () => void undoTidyName(renamed, original, windowId) },
  });
}

export async function tidyRename(d: Download, suggestion: TidyName, windowId: string): Promise<void> {
  const original = { filename: d.filename, path: d.path };
  const path = await applyTidyName(d, suggestion);

  if (!path) {
    showToast(windowId, "Couldn’t Rename the Download", "The name may already be in use.", { icon: "exclamationmark.triangle" });

    return;
  }

  showRenamed(d, original, path, windowId);
}

async function undoTidyName(d: Download, original: { filename: string; path: string }, windowId: string) {
  const path = hasServiceClient()
    ? await requestService<string | null>("downloadUndo", [d.id, original.filename])
    : await runDesktop(
        Effect.gen(function* () {
          const work = yield* DownloadWorkService;

          return yield* work.undo(d, original.filename);
        }),
      );

  if (!path) {
    showToast(windowId, "Couldn’t Undo", "The original name is no longer available.", { icon: "exclamationmark.triangle" });

    return;
  }

  showToast(windowId, "Download Name Reverted", clipped(baseName(path)), { icon: "arrow.uturn.backward" });
}

// MARK: Renaming finished downloads

/** This download won't be renamed when it finishes. */
export const keepDownloadName = (id: string) => void keptDownloads.add(id);

/**
 * A download finished: with Tidy Downloads on it gets a readable name right away, as in Arc, and a toast with the way
 * back. Once for each download, so an undo sticks. A name a person chose, or one already readable, is left alone.
 */
export async function tidyFinishedDownload(d: Download, s: BrowserState = useBrowser.getState(), owner?: BrowserStore): Promise<void> {
  if (!s.settings.tidyDownloads || d.state !== "finished" || !d.path) return;

  if (keptDownloads.has(d.id)) return;

  const finish = Effect.gen(function* () {
    const work = yield* DownloadWorkService;

    return yield* work.finish(d);
  });

  const named = owner ? await runForStore(owner, finish) : await runDesktop(finish);

  if (!named) return;

  const windowId = windowForDownload(s, d);

  if (!windowId) return;

  // Nobody asked for this rename, so a file that can't take the name just keeps its own.
  showRenamed(d, named.original, named.path, windowId);
}

/** Watches for downloads that finish while Bay watches, and gives them a readable name. */
export function startTidyDownloads(store: BrowserStore): () => void {
  // Only downloads that finish while Bay watches: the engine replays its finished history at every launch.
  const live = new Set<string>();

  const subscription = onDownload((d) => {
    if (d.state === "downloading") live.add(d.id);
    else if (live.delete(d.id) && d.state === "finished") void tidyFinishedDownload(d, store.getState(), store);
  });

  return () => subscription.remove();
}
