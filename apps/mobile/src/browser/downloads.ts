// The engines' downloads. The listener lives on the app scope, so every update reaches the store whether or not a
// screen is there to see it, and each one is recorded before the native callback returns. The screen watches the
// updates for its toast.
import type { DownloadUpdate } from "@bay/engine";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { NativeUnavailable } from "../effect/errors.ts";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Engine, type EngineError } from "../effect/ports/engine.ts";
import type { DownloadItem } from "../store/types.ts";

/** The screens following the downloads as they change. */
const watchers = new Set<(update: DownloadUpdate) => void>();

/** Calls `watcher` after each download update is recorded. The returned function stops it. */
export function watchDownloads(watcher: (update: DownloadUpdate) => void): () => void {
  watchers.add(watcher);

  return () => void watchers.delete(watcher);
}

/** Records every download update in the store until the scope closes. */
export const startDownloads: Effect.Effect<void, NativeUnavailable, Engine | BrowserState | Scope.Scope> = Effect.gen(function* () {
  const engine = yield* Engine;
  const browserState = yield* BrowserState;
  const dispatch = yield* browserState.dispatcher();

  yield* engine.onDownload((update) => {
    dispatch({ type: "download", update, now: Date.now() });

    for (const watcher of watchers) watcher(update);
  });
});

/** Opens a finished download: Quick Look on iOS, the app the system picks on Android. */
export const openDownload = (item: DownloadItem): Effect.Effect<void, EngineError, Engine> => Engine.use((engine) => engine.openDownload(item));

/**
 * Stops a download that is still running. One that ended while the user reached for the button can't be stopped,
 * and its row already says how it ended, so that refusal is not a failure.
 */
export const cancelDownload = (item: DownloadItem): Effect.Effect<void, never, Engine> =>
  Engine.use((engine) => engine.cancelDownload(item.id)).pipe(Effect.catchTag("EngineError", () => Effect.void));
