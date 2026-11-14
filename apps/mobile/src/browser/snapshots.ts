// Tab snapshots: the picture of each tab the switcher shows. One is taken a moment after a tab visits a page, so the
// page has drawn, and a newer visit replaces the picture the tab was still waiting for. Private tabs and pages that
// failed leave no picture behind. The pending picture is the tab's page work, so a tab that loads again, loses its
// view or closes takes it with it. Pictures are best effort: a page that can't be drawn keeps the one it had.
import type { Tab } from "@bay/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine } from "../effect/ports/engine.ts";
import { TabWork } from "./tabWork.ts";

/** How long a page has to draw after it loads before its picture is taken. */
export const SNAPSHOT_DELAY_MS = 700;

export class Snapshots extends Context.Service<
  Snapshots,
  {
    /**
     * A tab finished loading a page: its picture is taken once the page has had a moment to draw, unless `failed`
     * says by then that the page is the engine's error page. A newer visit replaces it.
     */
    readonly visited: (tabId: string, view: Tab, failed: () => boolean) => Effect.Effect<void>;
    /** Takes the tab's picture now, for the switcher that is about to show it. */
    readonly capture: (tabId: string, view: Tab, failed: () => boolean) => Effect.Effect<void>;
  }
>()("bay/Snapshots") {
  static readonly layer = Layer.effect(
    Snapshots,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;
      // The picture a tab is waiting for is its page work under one name, so a newer visit interrupts the one it replaces.
      const tabWork = yield* TabWork;

      const take = (tabId: string, view: Tab, failed: () => boolean) =>
        Effect.gen(function* () {
          const tab = (yield* browserState.data()).tabs.find((entry) => entry.id === tabId);

          // A closed tab has no card to draw, private pages leave no files behind, and an error page isn't the page.
          if (!tab || tab.private || failed()) return;

          const uri = yield* engine.snapshot(view);

          if (uri) yield* browserState.dispatch({ type: "update-tab", id: tabId, update: { snapshot: uri } });
        }).pipe(
          // A page that can't be drawn keeps the picture it had. A defect is still worth knowing about.
          Effect.catch(() => Effect.void),
          Effect.catchDefect((defect) => {
            const error = defect instanceof Error ? defect : new Error(String(defect));

            return diagnostics.report({ operation: { name: "snapshots.capture", resource: tabId }, message: error.message, cause: error });
          }),
        );

      return Snapshots.of({
        visited: (tabId, view, failed) =>
          tabWork.run(tabId, "snapshot", Effect.andThen(Effect.sleep(SNAPSHOT_DELAY_MS), take(tabId, view, failed))).pipe(Effect.asVoid),
        capture: take,
      });
    }),
  );
}
