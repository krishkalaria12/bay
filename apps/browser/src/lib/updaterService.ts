// The updater, as the app reaches it.
//
// The listener belongs to the app: it is registered once, in the app's scope, and given back when that scope
// closes. Sparkle stays the authority on what an update is — the app only follows what it reports.
import { onUpdatePending, updaterState, type PendingUpdate, type UpdaterState } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { usePendingUpdate } from "./updates";

/** The updater could not be asked. */
export class UpdaterFailure extends TaggedError("UpdaterFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The updater, as the app reaches it. */
export class UpdaterEngine extends Context.Service<
  UpdaterEngine,
  {
    /** Follows the updater. The subscription is given back when it is removed. */
    readonly watch: (listener: (pending: PendingUpdate | null) => void) => Effect.Effect<() => void, UpdaterFailure>;
    /** What the updater knows now. */
    readonly state: () => Effect.Effect<UpdaterState, UpdaterFailure>;
  }
>()("bay/UpdaterEngine") {
  static readonly layer = Layer.succeed(UpdaterEngine)({
    watch: (listener) =>
      Effect.sync(() => {
        const subscription = onUpdatePending(listener);

        return () => subscription.remove();
      }).pipe(Effect.catchDefect((cause) => Effect.fail(new UpdaterFailure({ operation: { name: "updater.watch" }, cause })))),
    state: () =>
      Effect.tryPromise({
        try: () => updaterState(),
        catch: (cause) => new UpdaterFailure({ operation: { name: "updater.state" }, cause }),
      }),
  });
}

/** The updater, owned by the app's scope. */
export class UpdaterService extends Context.Service<
  UpdaterService,
  {
    /** Starts following the updater. It is started once; a second start changes nothing. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/UpdaterService") {
  static readonly layer = Layer.effect(
    UpdaterService,
    Effect.gen(function* () {
      const engine = yield* UpdaterEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;

        const report = (failure: UpdaterFailure): Effect.Effect<void> =>
          diagnostics.report({
            operation: failure.operation,
            message: failure.message,
            cause: failure.cause instanceof Error ? failure.cause : undefined,
          });

        // The listener belongs to the app's scope: it is given back when the app closes, once.
        const remove = yield* engine
          .watch((pending) => usePendingUpdate.setState({ pending }))
          .pipe(Effect.catch((failure: UpdaterFailure) => report(failure).pipe(Effect.as(() => () => {}))));

        yield* Scope.addFinalizer(scope, Effect.sync(remove));

        // What the updater already knows: the listener only reports what happens next.
        const state = yield* engine.state().pipe(Effect.catch((failure: UpdaterFailure) => report(failure).pipe(Effect.as(null))));

        if (state?.available) yield* Effect.sync(() => usePendingUpdate.setState({ pending: state.pending ?? null }));
      });

      return UpdaterService.of({ start });
    }),
  );
}
