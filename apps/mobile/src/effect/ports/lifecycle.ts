// The app's state: whether it is in the foreground, in the background, or on its way between. One native registration
// for the whole app: a handler from any scope joins it, in the order the handlers were registered, and the registration
// goes when the last handler does. React Native is loaded inside the call, so this file stays importable where React
// Native is not.
import type { AppStateStatus } from "react-native";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { NativeUnavailable } from "../errors.ts";
import { Diagnostics } from "./diagnostics.ts";

/** Where the app is right now. */
export type AppStatus = "active" | "background" | "inactive";

/** The state React Native reports, as the states Bay knows. The others are states Bay has no use for. */
const appStatus = (status: AppStateStatus): AppStatus | null => {
  switch (status) {
    case "active":
    case "background":
    case "inactive":
      return status;
    default:
      return null;
  }
};

/** React Native's app state, loaded when it is first needed. */
const appStateModule = Effect.tryPromise({
  try: () => import("react-native").then((module) => module.AppState),
  catch: (cause) => new NativeUnavailable({ operation: { name: "lifecycle.load" }, cause }),
});

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    /**
     * Registers a handler for the app's state. Handlers run in the order they were registered, inside the native
     * callback, so what they start begins before the callback returns. It stops when the scope that registered it
     * closes.
     */
    readonly onChange: (handler: (status: AppStatus) => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Lifecycle") {
  static readonly layer = Layer.effect(
    Lifecycle,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;
      // Each registration is an entry of its own, so the same function registered twice is two handlers.
      const handlers = new Set<{ readonly handle: (status: AppStatus) => void }>();
      let subscription: { remove(): void } | undefined;

      /**
       * React Native's app state, or nothing when it could not be loaded. A missing native module is reported once and
       * the app carries on without the app state, rather than taking the whole scope down with it.
       */
      const appStateOrNothing = Effect.catchCause(appStateModule, (cause) => {
        const failure = Cause.squash(cause);
        const error = failure instanceof Error ? failure : new Error(String(failure));

        return Effect.map(diagnostics.report({ operation: { name: "lifecycle.load" }, message: error.message, cause: error }), () => undefined);
      });

      return Lifecycle.of({
        onChange: (handler) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const appState = yield* appStateOrNothing;

            if (!appState) return;

            const entry = { handle: handler };

            handlers.add(entry);

            subscription ??= appState.addEventListener("change", (status) => {
              const known = appStatus(status);

              if (!known) return;

              for (const each of handlers) each.handle(known);
            });

            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                handlers.delete(entry);

                // The last handler is gone, and the native registration goes with it.
                if (handlers.size > 0 || !subscription) return;

                subscription.remove();
                subscription = undefined;
              }),
            );
          }),
      });
    }),
  );
}
