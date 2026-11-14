// Work tied to a tab's current page: a silent sign-in waiting on the secure store, the picture the switcher is
// waiting for. It belongs to the page it started on, so it ends when the tab loads again, when its view goes and when
// the tab closes, and a late answer never reaches the next page. A tab runs each kind of work once at a time: running
// it again replaces the one still waiting. Clearing browsing data ends every tab's work.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { BrowserState } from "../effect/ports/browserState.ts";

/** The key a tab's work is kept under: the tab, then the kind of work. */
const keyOf = (tabId: string, name: string) => `${tabId}\n${name}`;

export class TabWork extends Context.Service<
  TabWork,
  {
    /**
     * Runs `program` for the tab's current page, under `name`: work already running under that name for the tab is
     * interrupted and replaced. The answer is the running fiber.
     */
    readonly run: <A, E, R>(tabId: string, name: string, program: Effect.Effect<A, E, R>) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
    /** Ends the work of a tab's page, and waits until it has stopped. */
    readonly end: (tabId: string) => Effect.Effect<void>;
    /** Ends the work of every tab, and waits until it has stopped. */
    readonly endAll: Effect.Effect<void>;
    /** Ends a tab's work when the tab closes. It runs on the app scope. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/TabWork") {
  static readonly layer = Layer.effect(
    TabWork,
    Effect.gen(function* () {
      const browserState = yield* BrowserState;
      const work = yield* FiberMap.make<string>();

      /**
       * The fibers a tab is running now. They are taken before any is interrupted, so work the tab starts while the
       * old work stops is the next page's and is left alone.
       */
      const fibersOf = (tabId: string) => {
        const prefix = keyOf(tabId, "");
        const fibers: Fiber.Fiber<unknown, unknown>[] = [];

        for (const [key, fiber] of work) if (key.startsWith(prefix)) fibers.push(fiber);

        return fibers;
      };

      return TabWork.of({
        run: (tabId, name, program) => FiberMap.run(work, keyOf(tabId, name))(program),
        end: (tabId) => Effect.suspend(() => Fiber.interruptAll(fibersOf(tabId))),
        endAll: FiberMap.clear(work),
        start: browserState.subscribe((data, previous) => {
          if (data.tabs === previous.tabs) return;

          const open = new Set(data.tabs.map((tab) => tab.id));

          for (const tab of previous.tabs) {
            if (open.has(tab.id)) continue;

            // The store's listener is a plain callback, so the closed tab's work is interrupted from here directly.
            for (const fiber of fibersOf(tab.id)) fiber.interruptUnsafe();
          }
        }),
      });
    }),
  );
}
