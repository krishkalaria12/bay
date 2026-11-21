// The cast picker, as the windows reach it. The engine's dialogs and routes are heard by the media service
// (service.ts): this is where a window opens and closes its dialog, and reads the routes its profile can cast to.
import type { CastRoute } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { runWindow } from "../../effect/windowRuntime";
import { useBrowserRead as useBrowser } from "../../store/read";
import { castProfile, MediaService, useCast, type Media } from "./service";

export { castProfile, useCast } from "./service";

if (__DEV__)
  // SAFETY: nnCast is a dev-only debug handle on globalThis with no ambient declaration; production never reads this name.
  (globalThis as { nnCast?: unknown }).nnCast = { useCast };

/** Runs something with the media work, on the runtime the app shares. */
export const withMedia = <A>(program: (media: Media) => Effect.Effect<A>): Promise<A> =>
  runWindow(
    Effect.gen(function* () {
      const media = yield* MediaService;

      return yield* program(media);
    }),
  );

/** Opens the cast dialog of the window's tab, or closes the one it has open. */
export function toggleCastPicker(windowId: string): Promise<void> {
  return withMedia((media) => media.toggleCastPicker(windowId));
}

/** Closes the cast dialog a tab has open. */
export function closeCastPicker(tabId: string) {
  void withMedia((media) => media.closeCastPicker(tabId));
}

const NONE: CastRoute[] = [];

export function useCastRoutes(windowId: string): CastRoute[] {
  const profile = useBrowser((s) => castProfile(s, windowId));

  return useCast((c) => c.routes[profile] ?? NONE);
}
