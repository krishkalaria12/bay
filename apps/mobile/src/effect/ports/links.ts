// The links that reach Bay from other apps: a deep link, a share, or the URL the app was launched with. One native
// registration per scope, so the app scope owns the only listeners there are. Expo is loaded inside the calls, so this
// file stays importable where Expo is not.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { NativeUnavailable, type Operation } from "../errors.ts";
import { Diagnostics } from "./diagnostics.ts";
import { Engine } from "./engine.ts";

/** A link that could not be read. */
export class LinksError extends TaggedError("LinksError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** What one scope registered: the native subscription and the handlers that read it. */
type Registration = {
  readonly subscription: { remove(): void };
  readonly handlers: Set<(url: string) => void>;
};

/** Expo's linking, loaded when it is first needed. */
const linkingModule = Effect.tryPromise({
  try: () => import("expo-linking"),
  catch: (cause) => new NativeUnavailable({ operation: { name: "links.load" }, cause }),
});

export class Links extends Context.Service<
  Links,
  {
    /** The URL the app was launched with, if it was launched with one. */
    readonly initial: () => Effect.Effect<string | null, LinksError>;
    /** Registers a handler for links from other apps. It stops when the scope that registered it closes. */
    readonly onLink: (handler: (url: string) => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Registers a handler for shares from other apps. It stops when the scope that registered it closes. */
    readonly onShare: (handler: (url: string) => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Takes the share that started the app, if there was one. */
    readonly takeShare: () => Effect.Effect<string | null, LinksError>;
  }
>()("bay/Links") {
  static readonly layer = Layer.effect(
    Links,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;
      const engine = yield* Engine;
      const registrations = new WeakMap<Scope.Scope, Registration>();

      /**
       * Expo's linking, or nothing when it could not be loaded. A missing native module is reported once and the app
       * carries on without incoming links, rather than taking the whole scope down with it.
       */
      const linkingOrNothing = Effect.catchCause(linkingModule, (cause) => {
        const failure = Cause.squash(cause);
        const error = failure instanceof Error ? failure : new Error(String(failure));

        return Effect.map(diagnostics.report({ operation: { name: "links.load" }, message: error.message, cause: error }), () => undefined);
      });

      return Links.of({
        initial: () =>
          Effect.tryPromise({
            try: async () => (await import("expo-linking")).getInitialURL(),
            catch: (cause) => new LinksError({ operation: { name: "links.initial" }, cause }),
          }),
        onLink: (handler) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const existing = registrations.get(scope);

            // The scope already listens: this handler joins the one native registration.
            if (existing) {
              existing.handlers.add(handler);

              return;
            }

            const linking = yield* linkingOrNothing;

            if (!linking) return;

            const handlers = new Set([handler]);

            const subscription = linking.addEventListener("url", ({ url }) => {
              for (const each of handlers) each(url);
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
        onShare: (handler) => engine.onShare(handler),
        takeShare: () => engine.takeShare().pipe(Effect.mapError((cause) => new LinksError({ operation: { name: "links.takeShare" }, cause }))),
      });
    }),
  );
}
