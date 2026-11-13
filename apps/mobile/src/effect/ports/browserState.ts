// The browser's own state: the tabs, the history and the preferences, as the store keeps them. Services read it and
// write to it through this port alone, so nothing reaches into the store from the outside. The store is loaded inside
// the calls, because it asks for the native engine the moment it is imported.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { NativeUnavailable } from "../errors.ts";
import type { BrowserAction } from "../../store/model.ts";
import type { BrowserData } from "../../store/types.ts";
import { Diagnostics } from "./diagnostics.ts";

/** The store's own module. */
type BrowserStoreModule = typeof import("../../store/browser.ts");

let loaded: Promise<BrowserStoreModule> | undefined;

/** The store once it has loaded. */
let store: BrowserStoreModule | undefined;

/**
 * The store, loaded when it is first needed. Once it is there it is handed over at once, so a call made from a native
 * callback, like leaving the foreground, reaches the store before the callback returns.
 */
const storeModule = Effect.suspend(() =>
  store
    ? Effect.succeed(store)
    : Effect.tryPromise({
        try: () => {
          loaded ??= import("../../store/browser.ts").then((module) => (store = module));

          return loaded;
        },
        catch: (cause) => new NativeUnavailable({ operation: { name: "browserState.load" }, cause }),
      }),
);

export class BrowserState extends Context.Service<
  BrowserState,
  {
    /** The state as it is now. */
    readonly data: () => Effect.Effect<BrowserData, NativeUnavailable>;
    /** Whether the saved state has been read and the store is the one the app draws from. */
    readonly ready: () => Effect.Effect<boolean, NativeUnavailable>;
    /** Waits until the saved state has been read. Reading it may change nothing, so this is not a change to subscribe to. */
    readonly awaitReady: () => Effect.Effect<void, NativeUnavailable>;
    /** Changes the state. */
    readonly dispatch: (action: BrowserAction) => Effect.Effect<void, NativeUnavailable>;
    /**
     * Replaces the state with the saved one, archiving the tabs left alone too long, and says the store is ready. With
     * nothing saved, the state the store started with stays and is ready as it is.
     */
    readonly restore: (saved: BrowserData | null) => Effect.Effect<void, NativeUnavailable>;
    /** Calls `listener` when the state changes. It stops when the scope that registered it closes. */
    readonly subscribe: (listener: (data: BrowserData, previous: BrowserData) => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/BrowserState") {
  static readonly layer = Layer.effect(
    BrowserState,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;

      /**
       * The store, or nothing when it could not be loaded. A missing store is reported once and the app carries on
       * without the state, rather than taking the whole scope down with it.
       */
      const storeOrNothing = Effect.catchCause(storeModule, (cause) => {
        const failure = Cause.squash(cause);
        const error = failure instanceof Error ? failure : new Error(String(failure));

        return Effect.map(diagnostics.report({ operation: { name: "browserState.load" }, message: error.message, cause: error }), () => undefined);
      });

      return BrowserState.of({
        data: () => Effect.flatMap(storeModule, (module) => Effect.sync(() => module.useBrowserStore.getState().data)),
        ready: () => Effect.flatMap(storeModule, (module) => Effect.sync(() => module.useBrowserStore.getState().ready)),
        awaitReady: () =>
          Effect.flatMap(storeModule, (module) =>
            Effect.callback<void>((resume) => {
              if (module.useBrowserStore.getState().ready) return resume(Effect.void);

              const unsubscribe = module.useBrowserStore.subscribe((state) => {
                if (!state.ready) return;

                unsubscribe();
                resume(Effect.void);
              });

              return Effect.sync(unsubscribe);
            }),
          ),
        dispatch: (action) => Effect.flatMap(storeModule, (module) => Effect.sync(() => module.useBrowserStore.getState().dispatch(action))),
        restore: (saved) => Effect.flatMap(storeModule, (module) => Effect.sync(() => module.useBrowserStore.getState().restore(saved))),
        subscribe: (listener) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const module = yield* storeOrNothing;

            if (!module) return;

            const unsubscribe = module.useBrowserStore.subscribe((state, previous) => {
              // The store keeps the same data when an action changes nothing, and that is not a change.
              if (state.data === previous.data) return;

              listener(state.data, previous.data);
            });

            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => unsubscribe()),
            );
          }),
      });
    }),
  );
}
