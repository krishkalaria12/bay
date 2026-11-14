// Clearing browsing data. A page still on screen can write fresh cookies and storage the moment after they are
// cleared, so the wipe first stops the work tied to each tab's page, resets the browser, which takes every page
// view off the screen, and waits until the last view has gone before the engine clears what pages kept. The wait is
// capped, so a view that never reports going can't hold the wipe up. Once the browser is reset the wipe always
// finishes: an empty browser over data that was never cleared is the one outcome it must not leave. A failure is the
// caller's to show, and nothing here tries again.
import type { Tab } from "@bay/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Engine, type EngineError } from "../effect/ports/engine.ts";
import { TabWork } from "./tabWork.ts";

/** The longest the wipe waits for the page views to go before it clears anyway. */
export const VIEWS_GONE_MS = 1_000;

/** The page views on screen, by tab. It says when the last one goes. */
export class ViewRegistry extends Map<string, Tab> {
  private readonly emptied = new Set<() => void>();

  override delete(tabId: string): boolean {
    const deleted = super.delete(tabId);

    if (deleted && this.size === 0) for (const listener of [...this.emptied]) listener();

    return deleted;
  }

  /** Calls `listener` each time the last view goes, until the returned function is called. */
  onEmpty(listener: () => void): () => void {
    this.emptied.add(listener);

    return () => {
      this.emptied.delete(listener);
    };
  }
}

/** What the screen hands the wipe: how to reset it, and the views it is waiting on. */
export type ClearingScreen = {
  /** Resets the browser and the screen's own state, which takes every page view off the screen. */
  readonly reset: () => void;
  readonly views: Pick<ViewRegistry, "size" | "onEmpty">;
};

/** Waits until no page view is left on screen. */
const viewsGone = (views: ClearingScreen["views"]): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (views.size === 0) {
      resume(Effect.void);

      return;
    }

    const stop = views.onEmpty(() => resume(Effect.void));

    return Effect.sync(stop);
  });

export class ClearData extends Context.Service<
  ClearData,
  {
    /** Clears cookies, website storage, the network cache and the tab snapshots, and starts the browser afresh. */
    readonly clear: (screen: ClearingScreen) => Effect.Effect<void, EngineError>;
  }
>()("bay/ClearData") {
  static readonly layer = Layer.effect(
    ClearData,
    Effect.gen(function* () {
      const tabWork = yield* TabWork;
      const engine = yield* Engine;

      return ClearData.of({
        clear: (screen) =>
          Effect.gen(function* () {
            // A sign-in still looking for a saved login, or a picture still waiting to be taken, belongs to a page that
            // is about to go: it stops before anything is reset.
            yield* tabWork.endAll;

            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                // The reset takes the pages off the screen, and the reading tools and find that worked on them end
                // with the documents they were keyed to.
                yield* Effect.sync(screen.reset);

                yield* viewsGone(screen.views).pipe(Effect.timeoutOrElse({ duration: VIEWS_GONE_MS, orElse: () => Effect.void }));
                yield* engine.clearData();
              }),
            );
          }),
      });
    }),
  );
}
