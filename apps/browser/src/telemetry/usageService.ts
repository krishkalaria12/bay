// The usage sampling, on the app's grid.
//
// The samples are the app's own work: an hour's worth of counts, the command bar's speed, the Mac's memory. The
// hourly one runs on the shared grid, so it wakes the app with the rest of the periodic work and not on a timer of
// its own. The one-off samples wait for a moment and are then done.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Scheduler } from "../effect/ports/scheduler";
import { FIRST_MEMORY_SAMPLE_MS } from "./config";
import { reportNativeCrashesOnce, sampleMemoryOnce, sampleUsage } from "./usage";

// How often the usage is sampled.
const HOUR_MS = 60 * 60_000;

// How long after the app starts the Mac's crashes from the last run are read.
const CRASH_REPORT_DELAY_MS = 5_000;

export class UsageService extends Context.Service<
  UsageService,
  {
    /** Starts the sampling. It is started once; a second start changes nothing. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/UsageService") {
  static readonly layer = Layer.effect(
    UsageService,
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const scope = yield* Scope.Scope;

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;

        // The hourly sample: the app's grid, so it wakes with the rest of the periodic work.
        yield* scheduler.every({ every: HOUR_MS, run: Effect.sync(sampleUsage) });

        // The one-off samples: they wait for a moment, and the app's scope holds them until then.
        yield* Effect.forkIn(Effect.sleep(Duration.millis(CRASH_REPORT_DELAY_MS)).pipe(Effect.andThen(Effect.sync(reportNativeCrashesOnce))), scope);

        yield* Effect.forkIn(Effect.sleep(Duration.millis(FIRST_MEMORY_SAMPLE_MS)).pipe(Effect.andThen(Effect.sync(sampleMemoryOnce))), scope);
      });

      return UsageService.of({ start });
    }),
  );
}
