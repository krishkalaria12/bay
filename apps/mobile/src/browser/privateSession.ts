// The private session: the engine keeps private tabs' cookies and storage in one session that lasts while any private
// tab is open. Only a few page views stay mounted, so the session belongs to the private tabs, not to their views: it
// ends when the last private tab closes, and a launch (which never restores private tabs) ends any left over.
//
// The session follows the store from the app scope. Calls reach native one at a time, in order, and only the newest
// wish is sent: opening and closing a private tab quickly ends the session once, after the last change.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine } from "../effect/ports/engine.ts";
import type { BrowserData } from "../store/types.ts";

/** Whether the state has a private tab open. */
const hasPrivateTabs = (data: BrowserData): boolean => data.tabs.some((tab) => tab.private);

export class PrivateSession extends Context.Service<
  PrivateSession,
  {
    /** Tells the engine whether a private tab is open now, then follows the store until the scope closes. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/PrivateSession") {
  static readonly layer = Layer.effect(
    PrivateSession,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const browserState = yield* BrowserState;
      const diagnostics = yield* Diagnostics;

      return PrivateSession.of({
        start: Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          // Only the newest wish waits: a newer one pushes out the one before it.
          const wishes = yield* Queue.sliding<boolean>(1);
          // What native was last told, so the same answer isn't sent twice. Nothing has been sent at launch.
          let sent: boolean | null = null;

          const send = Effect.gen(function* () {
            const active = yield* Queue.take(wishes);

            if (active === sent) return;

            yield* engine.setPrivateSessionActive(active).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  sent = active;
                }),
              ),
              // The next change asks again: native was not told, so what it was last told still stands.
              Effect.catch((error) => diagnostics.report({ operation: error.operation, message: "The private session could not be updated", cause: error })),
            );
          });

          yield* Effect.forkIn(Effect.forever(send), scope);

          yield* browserState.subscribe((next, previous) => {
            const active = hasPrivateTabs(next);

            if (active !== hasPrivateTabs(previous)) Queue.offerUnsafe(wishes, active);
          });

          // Read after subscribing, so a change in between can't be missed: this is the newest state either way.
          const data = yield* browserState
            .data()
            .pipe(
              Effect.catch((error) =>
                diagnostics.report({ operation: error.operation, message: "The private session could not read the tabs", cause: error }).pipe(Effect.as(null)),
              ),
            );

          // Once at launch, as the engine requires, whatever the tabs are.
          if (data) Queue.offerUnsafe(wishes, hasPrivateTabs(data));
        }),
      });
    }),
  );
}
