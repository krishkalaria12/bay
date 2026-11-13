// The app's state: whether it is in the foreground, in the background, or on its way between. One native registration
// per scope, so the app scope owns the only listener there is. React Native is loaded inside the call, so this file
// stays importable where React Native is not.
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

/** What one scope registered: the native subscription and the handlers that read it. */
type Registration = {
  readonly subscription: { remove(): void };
  readonly handlers: Set<(status: AppStatus) => void>;
};

/** React Native's app state, loaded when it is first needed. */
const appStateModule = Effect.tryPromise({
  try: () => import("react-native").then((module) => module.AppState),
  catch: (cause) => new NativeUnavailable({ operation: { name: "lifecycle.load" }, cause }),
});

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    /** Registers a handler for the app's state. It stops when the scope that registered it closes. */
    readonly onChange: (handler: (status: AppStatus) => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Lifecycle") {
  static readonly layer = Layer.effect(
    Lifecycle,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;
      const registrations = new WeakMap<Scope.Scope, Registration>();

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
            const existing = registrations.get(scope);

            // The scope already listens: this handler joins the one native registration.
            if (existing) {
              existing.handlers.add(handler);

              return;
            }

            const appState = yield* appStateOrNothing;

            if (!appState) return;

            const handlers = new Set([handler]);

            const subscription = appState.addEventListener("change", (status) => {
              const known = appStatus(status);

              if (!known) return;

              for (const each of handlers) each(known);
            });

            registrations.set(scope, { subscription, handlers });

            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                registrations.delete(scope);
                subscription.remove();
              }),
            );
          }),
      });
    }),
  );
}
