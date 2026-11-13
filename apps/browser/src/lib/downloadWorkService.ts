// The app's downloads and their names: what a finished download is called, and the way back.
//
// A rename is a job: the file is renamed once, the app's record follows it, and a download that was already
// handled is left alone. The name the local cleaner suggests is the app's own; the model only improves it.
import { isUserNamedDownload, modelTidyName, tidyDownloadName, type TidyName } from "@bay/core";
import { renameFile, tidyNames } from "@bay/desktop";
import type { Download } from "@bay/chromium";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthorityStore } from "../effect/ports/store";
import type { BrowserState } from "../store/browserStore";
import type { BrowserProjection } from "../runtime/projection";
import { browserRead } from "../store/read";
import { downloadsIn } from "../store/windowUi";
import { engineProfile } from "../store/model";
import { isInternalTab } from "../components/pages/internalPages";

// The name renameFile settled on, which gains " (1)" when the suggestion was taken.
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

type DownloadPageContext = { title?: string; url?: string };

function stripHash(url: string): string {
  return url.split("#")[0] ?? "";
}

function sameDocument(a: string, b: string): boolean {
  const x = stripHash(a).replace(/\/$/, "");
  const y = stripHash(b).replace(/\/$/, "");

  return x === y;
}

/** The page a download came from, so its name can say something about it. */
export function pageForDownload(
  d: Download,
  s: Pick<BrowserProjection, "tabs" | "windowOrder" | "windows" | "downloads" | "spaceOrder" | "history"> = browserRead.getState(),
): DownloadPageContext {
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

/** The window a download belongs to. */
export function windowForDownload(s: Pick<BrowserProjection, "ui" | "windowOrder" | "downloads" | "windows">, d: Download): string | null {
  const focused = s.ui.focusedWindowId;

  if (focused && downloadsIn(s, focused).some((x) => x.id === d.id)) return focused;

  return s.windowOrder.find((id) => downloadsIn(s, id).some((x) => x.id === d.id)) ?? null;
}

/** The download could not be renamed. */
export class DownloadFailure extends TaggedError("DownloadFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The Mac's side of the downloads: the file system and the model that names a file. */
export class DownloadEngine extends Context.Service<
  DownloadEngine,
  {
    readonly rename: (path: string, filename: string) => Effect.Effect<string | null, DownloadFailure>;
    /** The model's better name, when it has one. */
    readonly suggest: (filename: string, title: string, url: string) => Effect.Effect<TidyName | null>;
  }
>()("bay/DownloadEngine") {
  static readonly layer = Layer.succeed(DownloadEngine)({
    rename: (path, filename) =>
      Effect.tryPromise({
        try: () => renameFile(path, filename),
        catch: (cause) => new DownloadFailure({ operation: "download.rename", cause }),
      }),
    suggest: (filename, title, url) =>
      Effect.suspend(() => {
        const names = tidyNames;

        if (!names) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => names.suggest(filename, title, url),
          catch: () => null,
        }).pipe(
          Effect.map((answer) => (answer ? modelTidyName(answer, filename) : null)),
          Effect.catch(() => Effect.succeed(null)),
        );
      }),
  });
}

export class DownloadWorkService extends Context.Service<
  DownloadWorkService,
  {
    /** Renames a finished download, and tells the app where it went. */
    readonly rename: (download: Download, suggestion: TidyName) => Effect.Effect<string | null, DownloadFailure>;
    /** Puts a download's own name back. */
    readonly undo: (download: Download, filename: string) => Effect.Effect<string | null, DownloadFailure>;
    /** Names a finished download, once. */
    readonly finish: (download: Download) => Effect.Effect<{ path: string; original: { filename: string; path: string } } | null, DownloadFailure>;
  }
>()("bay/DownloadWorkService") {
  static readonly layer = Layer.effect(
    DownloadWorkService,
    Effect.gen(function* () {
      const browser = yield* AuthorityStore;
      const engine = yield* DownloadEngine;

      // The downloads that were named already: once for each download, so an undo sticks.
      const handled = new Set<string>();

      const cleanedName = (d: Download, s: BrowserState): TidyName | null => {
        const page = pageForDownload(d, s);

        return tidyDownloadName({
          filename: d.filename,
          pageTitle: page.title,
          pageUrl: page.url ?? d.tabUrl ?? d.referrer,
          mimeType: d.mimeType,
        });
      };

      const rename = (download: Download, suggestion: TidyName): Effect.Effect<string | null, DownloadFailure> =>
        Effect.gen(function* () {
          if (download.state !== "finished" || !download.path) return yield* Effect.succeed(null);

          const path = yield* engine.rename(download.path, suggestion.filename);

          if (!path) return yield* Effect.succeed(null);

          yield* Effect.sync(() => browser.getState().updateDownloadFile(download.id, { filename: baseName(path), path }));

          return yield* Effect.succeed(path);
        });

      const undo = (download: Download, filename: string): Effect.Effect<string | null, DownloadFailure> =>
        Effect.gen(function* () {
          const path = yield* engine.rename(download.path, filename);

          if (!path) return yield* Effect.succeed(null);

          yield* Effect.sync(() => browser.getState().updateDownloadFile(download.id, { filename: baseName(path), path }));

          return yield* Effect.succeed(path);
        });

      const finish = (download: Download): Effect.Effect<{ path: string; original: { filename: string; path: string } } | null, DownloadFailure> =>
        Effect.gen(function* () {
          const s = browser.getState();

          if (!s.settings.tidyDownloads || download.state !== "finished" || !download.path) return yield* Effect.succeed(null);

          if (handled.has(download.id)) return yield* Effect.succeed(null);

          handled.add(download.id);

          if (isUserNamedDownload(download.filename, download.suggestedFilename)) return yield* Effect.succeed(null);

          const windowId = windowForDownload(s, download);
          const cleaned = cleanedName(download, s);

          if (!windowId || !cleaned) return yield* Effect.succeed(null);

          const page = pageForDownload(download, s);
          const suggested = yield* engine.suggest(download.filename, page.title ?? "", page.url ?? download.tabUrl ?? download.referrer ?? "");
          const name = suggested ?? cleaned;

          // The model takes a moment: the file may have been renamed, removed or the setting turned off meanwhile.
          const now = browser.getState();
          const current = now.downloads.find((x) => x.id === download.id);

          if (!now.settings.tidyDownloads || !current || current.filename !== download.filename || current.state !== "finished") {
            return yield* Effect.succeed(null);
          }

          const original = { filename: current.filename, path: current.path };
          const path = yield* rename(current, name ?? cleaned);

          if (!path) return yield* Effect.succeed(null);

          return yield* Effect.succeed({ path, original });
        });

      return DownloadWorkService.of({ rename, undo, finish });
    }),
  );
}
