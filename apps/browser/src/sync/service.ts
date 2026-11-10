import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { Diagnostics } from "../effect/ports/diagnostics";
import { SYNC_AFTER_EDIT_MS, SYNC_CYCLE_MS } from "./constants";

export class SyncStopped extends TaggedError("SyncStopped")<{}> {}

export class SyncFailure extends TaggedError("SyncFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

// The existing engine owns records and persistence. The worker owns when a cycle runs and when it is safe to stop.
export type SyncWork = {
  readonly enabled: () => boolean;
  readonly initialize: Effect.Effect<void, SyncFailure>;
  readonly cycle: (retiring: boolean, forcePasswords: boolean) => Effect.Effect<void, SyncFailure>;
  readonly updating: () => void;
  readonly retire: () => boolean;
  readonly stop: (deleteData: boolean) => Effect.Effect<void, SyncFailure>;
  readonly subscribe: (schedule: (delay?: number) => void) => () => void;
};

export type SyncWorker = {
  readonly schedule: (delay?: number) => void;
  readonly now: Effect.Effect<void, SyncStopped>;
  readonly stop: (deleteData?: boolean) => Effect.Effect<void, SyncFailure>;
  readonly resume: () => void;
};

export class Sync extends Context.Service<
  Sync,
  {
    readonly open: (work: SyncWork) => Effect.Effect<SyncWorker>;
  }
>()("bay/Sync") {
  static readonly layer = Layer.effect(
    Sync,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const diagnostics = yield* Diagnostics;

      const open = Effect.fnUntraced(function* (work: SyncWork) {
        const clock = yield* Clock.Clock;
        // Signals coalesce; no native callback blocks on a full queue.
        const wake = yield* Queue.sliding<void>(1);
        const pending = new Set<Deferred.Deferred<void, SyncStopped>>();
        let current: Deferred.Deferred<void, SyncStopped>[] = [];
        let mode: "active" | "stopping" | "stopped" | "disposed" = "active";
        let dueAt: number | undefined;
        let initialized = false;
        let stopping: { done: Deferred.Deferred<void, SyncFailure>; deleteData: boolean } | undefined;

        const signal = () => void Queue.offerUnsafe(wake, undefined);

        const schedule = (delay = SYNC_AFTER_EDIT_MS) => {
          if (mode !== "active" || !work.enabled()) return;
          // An explicit request cannot be pushed back by ordinary edits.
          dueAt = pending.size ? clock.currentTimeMillisUnsafe() : clock.currentTimeMillisUnsafe() + delay;
          signal();
        };

        const cancelWaiters = () => {
          for (const waiter of [...current, ...pending]) Deferred.doneUnsafe(waiter, Effect.fail(new SyncStopped()));
          pending.clear();
          current = [];
        };

        const report = Effect.fnUntraced(function* (cause: Cause.Cause<SyncFailure>) {
          if (Cause.hasInterruptsOnly(cause)) return;

          // Native errors can include paths or content. Report the operation, not the raw payload.
          yield* diagnostics.report({ operation: { name: "sync.worker" }, message: "Sync work failed" });
        });

        const cycle = Effect.fnUntraced(function* (retiring: boolean, forced: boolean) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.forkScoped(Effect.delay(Effect.sync(work.updating), 1000).pipe(Effect.interruptible));
              yield* work.cycle(retiring, forced);
            }),
          );
        }, Effect.uninterruptible);

        const now = Effect.gen(function* () {
          if (mode !== "active") return yield* Effect.fail(new SyncStopped());

          if (!work.enabled()) return;

          const waiter = yield* Deferred.make<void, SyncStopped>();

          pending.add(waiter);
          dueAt = clock.currentTimeMillisUnsafe();
          signal();

          yield* Deferred.await(waiter).pipe(Effect.ensuring(Effect.sync(() => pending.delete(waiter))));
        });

        const stop = Effect.fnUntraced(function* (deleteData = false) {
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (mode === "disposed") return;

              if (!stopping) {
                mode = "stopping";
                dueAt = undefined;
                cancelWaiters();
                stopping = { done: yield* Deferred.make<void, SyncFailure>(), deleteData };
                signal();
              }

              // Admission is atomic; cancelling this wait cannot abandon a half-enqueued stop.
              yield* restore(Deferred.await(stopping.done));
            }),
          );
        });

        const tick = Effect.gen(function* () {
          if (mode === "stopping" && stopping) {
            const request = stopping;

            const exit = yield* Effect.exit(
              Effect.gen(function* () {
                if (initialized && work.enabled() && work.retire()) {
                  const retired = yield* Effect.exit(cycle(true, false));

                  if (Exit.isFailure(retired)) yield* report(retired.cause);
                }

                yield* work.stop(request.deleteData);
              }).pipe(Effect.uninterruptible),
            );

            mode = "stopped";
            stopping = undefined;
            yield* Deferred.done(request.done, exit);

            return;
          }

          if (mode !== "active" || dueAt === undefined) {
            yield* Queue.take(wake);

            return;
          }

          const delay = dueAt - clock.currentTimeMillisUnsafe();

          if (delay > 0) {
            yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(delay));

            return;
          }

          dueAt = undefined;
          current = [...pending];
          pending.clear();

          // Native sync has no cancellation API. Keep ownership until its Promise (and tracked writes) settles.
          const exit = yield* Effect.exit(cycle(false, current.length > 0));

          if (Exit.isFailure(exit)) yield* report(exit.cause);

          for (const waiter of current) yield* Deferred.succeed(waiter, undefined);
          current = [];

          if (mode === "active" && dueAt === undefined && work.enabled()) dueAt = clock.currentTimeMillisUnsafe() + SYNC_CYCLE_MS;
        });

        const initialize = Effect.gen(function* () {
          const exit = yield* Effect.exit(work.initialize.pipe(Effect.uninterruptible));

          initialized = Exit.isSuccess(exit);

          if (Exit.isFailure(exit)) {
            // A failed unlock/state read must not be followed by a cycle on empty scopes.
            if (mode === "active") mode = "stopped";
            dueAt = undefined;
            cancelWaiters();
            yield* report(exit.cause);
          }
        });

        const unsubscribe = work.subscribe(schedule);

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            mode = "disposed";
            dueAt = undefined;
            unsubscribe();
            cancelWaiters();
            Queue.shutdownUnsafe(wake);
          }),
        );

        yield* Effect.forkIn(Effect.andThen(initialize, Effect.forever(tick)), scope);

        return {
          schedule,
          now,
          stop,
          resume: () => {
            if (mode === "disposed" || mode === "stopping") return;
            // Only called once setup or recovery has installed a usable sync state.
            initialized = true;
            mode = "active";
            schedule(0);
          },
        } satisfies SyncWorker;
      });

      return Sync.of({ open });
    }),
  );
}
