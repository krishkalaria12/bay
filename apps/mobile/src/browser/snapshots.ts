// Tab snapshots: the picture of each tab the switcher shows. One is taken a moment after a tab visits a page, so the
// page has drawn, and a newer visit replaces the picture the tab was still waiting for. Private tabs and pages that
// failed leave no picture behind, and a tab that closes takes its pending picture with it. Pictures are best effort:
// a page that can't be drawn keeps the one it had.
import type { Tab } from "@bay/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine } from "../effect/ports/engine.ts";

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
    /** Lets go of the pictures closed tabs were waiting for. It runs on the app scope. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Snapshots") {
  static readonly layer = Layer.effect(
    Snapshots,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;
      // The picture each tab is waiting for. Running another one for the same tab interrupts the one it replaces.
      const pending = yield* FiberMap.make<string>();

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
          FiberMap.run(pending, tabId)(Effect.andThen(Effect.sleep(SNAPSHOT_DELAY_MS), take(tabId, view, failed))).pipe(Effect.asVoid),
        capture: take,
        start: browserState.subscribe((data, previous) => {
          if (data.tabs === previous.tabs) return;

          const open = new Set(data.tabs.map((tab) => tab.id));

          for (const tab of previous.tabs) {
            if (open.has(tab.id)) continue;

            const waiting = FiberMap.getUnsafe(pending, tab.id);

            // The store's listener is a plain callback, so the closed tab's capture is interrupted from here directly.
            if (Option.isSome(waiting)) waiting.value.interruptUnsafe();
          }
        }),
      });
    }),
  );
}
