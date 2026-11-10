// The app's periodic work, on one timer. lib/throttledTimers.ts keeps the aligned grid: the periods are multiples of
// each other, so work that falls due together wakes the app once, and with nothing to do there is no timer at all.
// This is the scoped door into it. A job registered here is removed when the scope that registered it closes, and a
// job that fails is reported once rather than restarted.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { everySlowly, type SlowJob } from "../../lib/throttledTimers";
import { Diagnostics } from "./diagnostics";

/** A job on the grid: what to do, how often, and what makes it worth doing. */
export type ScheduledWork = Omit<SlowJob, "run"> & {
  /** The work to do when the slot comes round. Its dependencies are already provided. */
  readonly run: Effect.Effect<void, Error>;
};

export class Scheduler extends Context.Service<
  Scheduler,
  {
    /** Registers a job on the grid. It runs until the scope that registered it closes. */
    readonly every: (job: ScheduledWork) => Effect.Effect<void>;
  }
>()("bay/Scheduler") {
  static readonly layer = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const diagnostics = yield* Diagnostics;

      const runJob = (job: ScheduledWork) => {
        const work = job.run.pipe(
          Effect.catchCause((cause) => {
            const failure = Cause.squash(cause);
            const error = failure instanceof Error ? failure : new Error(String(failure));

            return diagnostics.report({ operation: { name: "scheduler.job" }, message: error.message, cause: error });
          }),
        );

        // The job runs in the app's scope, so closing the app stops it.
        void Effect.runPromiseExit(Effect.forkIn(work, scope));
      };

      return Scheduler.of({
        every: (job) =>
          Effect.suspend(() => {
            const stop = everySlowly({
              every: job.every,
              needed: job.needed,
              watch: job.watch,
              run: () => runJob(job),
            });

            return Scope.addFinalizer(scope, Effect.sync(stop));
          }),
      });
    }),
  );
}
