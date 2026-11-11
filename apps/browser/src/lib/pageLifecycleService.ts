// The lifetime of the app's pages: which ones sleep, and which reopen at launch.
//
// The service owns what keeps the policy running: the Mac's window, app and memory events, the store subscription
// that starts a hidden tab's idle time, the sweep on the shared grid, and the waits before the recent tabs reopen.
// They are registered once and given back when the app's scope closes, and a wait that has not come round by then
// does nothing. The policy itself stays plain (tabLifecycle.ts): which tabs are kept, which sleep, and the check a
// page answers before it does. A sweep runs one at a time; a page is put to sleep only while it is still the page
// the sweep looked at, and never while it is shown, kept, busy or holding unsaved input.
import { onSystemState, systemState, type SystemState } from "@bay/chromium";
import { onAppEvent, onWindowEvent, type AppEvent, type WindowEvent } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { Scheduler } from "../effect/ports/scheduler";
import { useBrowser } from "../store/browserStore";
import { LIFECYCLE_SWEEP_MS } from "./constants";
import {
  installLifecycleDevHandle,
  lastSystem,
  noteSystem,
  RELOAD_SPACING_MS,
  recentTabsToReload,
  setAppActive,
  sweep,
  trackShown,
  wakeRecentTab,
} from "./tabLifecycle";

/** How long after launch the recent tabs start to reopen. */
const RELOAD_AFTER_MS = 3000;

/** The Mac could not say how much memory and power it has. */
export class LifecycleFailure extends TaggedError("LifecycleFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The Mac, as the pages' lifetime reaches it. */
export class LifecycleEngine extends Context.Service<
  LifecycleEngine,
  {
    /** Registers a handler for the windows the Mac reports. The answer gives it back. */
    readonly onWindowEvent: (listener: (event: WindowEvent) => void) => Effect.Effect<() => void>;
    /** Registers a handler for the app's own events. The answer gives it back. */
    readonly onAppEvent: (listener: (event: AppEvent) => void) => Effect.Effect<() => void>;
    /** The Mac's memory and power, as they are now. */
    readonly systemState: () => Effect.Effect<SystemState, LifecycleFailure>;
    /** Registers a handler for changes to the Mac's memory and power. The answer gives it back. */
    readonly onSystemState: (listener: (state: SystemState) => void) => Effect.Effect<() => void>;
    /** Sleeps what can sleep, and says which tabs did. One sweep at a time: a second one while it runs does nothing. */
    readonly sweep: () => Effect.Effect<string[]>;
  }
>()("bay/LifecycleEngine") {
  static readonly layer = Layer.succeed(LifecycleEngine)({
    onWindowEvent: (listener) => subscribe(() => onWindowEvent(listener)),
    onAppEvent: (listener) => subscribe(() => onAppEvent(listener)),
    systemState: () =>
      Effect.tryPromise({
        try: () => systemState(),
        catch: (cause) => new LifecycleFailure({ operation: { name: "lifecycle.system" }, cause }),
      }),
    onSystemState: (listener) => subscribe(() => onSystemState(listener)),
    sweep: () => Effect.promise(() => sweep()),
  });
}

function subscribe(register: () => { remove: () => void }): Effect.Effect<() => void> {
  return Effect.sync(() => {
    const subscription = register();

    return () => subscription.remove();
  });
}

export class PageLifecycleService extends Context.Service<
  PageLifecycleService,
  {
    /** Hears the Mac, sweeps on the shared grid, and reopens the recent tabs once the Mac has said what it has. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/PageLifecycleService") {
  static readonly layer = Layer.effect(
    PageLifecycleService,
    Effect.gen(function* () {
      const engine = yield* LifecycleEngine;
      const scheduler = yield* Scheduler;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The work a native callback starts belongs to the app's scope, with the runtime's own services.
      let services: Context.Context<never> = Context.empty();

      const fork = (work: Effect.Effect<unknown>): void => {
        void Effect.runForkWith(services)(Effect.forkIn(work, scope, { startImmediately: true }));
      };

      // The recent tabs reopen one after another, each after its wait: a wait the scope ends reopens nothing, and
      // each one checks the Mac again before it does.
      const reloadRecent = (sys: SystemState): Effect.Effect<void> =>
        Effect.gen(function* () {
          const ids = recentTabsToReload(sys);

          for (const id of ids) {
            yield* Effect.sleep(Duration.millis(RELOAD_SPACING_MS));

            wakeRecentTab(id, sys);
          }
        });

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;
        services = yield* Effect.context<never>();

        const removeWindows = yield* engine.onWindowEvent((e) => {
          if (e.type === "focus") setAppActive(true);
        });

        const removeApp = yield* engine.onAppEvent((e) => {
          if (e.type === "resignActive" || e.type === "screenLocked") setAppActive(false);
        });

        trackShown();

        const stopTracking = useBrowser.subscribe((s, prev) => {
          if (s.windows !== prev.windows || s.splits !== prev.splits) trackShown(s);
        });

        let removeSystem: (() => void) | undefined;

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            removeWindows();
            removeApp();
            stopTracking();
            removeSystem?.();
            started = false;
          }),
        );

        yield* scheduler.every({
          every: LIFECYCLE_SWEEP_MS,
          run: Effect.gen(function* () {
            trackShown();

            yield* engine.sweep();
          }),
        });

        if (__DEV__) installLifecycleDevHandle();

        // The Mac says what memory and power it has: until it does, nothing reopens, and memory pressure that
        // rises later sweeps at once.
        fork(
          Effect.gen(function* () {
            const state = yield* engine.systemState();

            noteSystem(state);

            removeSystem = yield* engine.onSystemState((next) => {
              if (noteSystem(next)) fork(engine.sweep());
            });

            yield* Effect.sleep(Duration.millis(RELOAD_AFTER_MS));
            yield* reloadRecent(lastSystem() ?? state);
          }).pipe(
            Effect.catch((failure) =>
              diagnostics.report({
                operation: failure.operation,
                message: failure.message,
                cause: failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause)),
              }),
            ),
          ),
        );
      });

      return PageLifecycleService.of({ start });
    }),
  );
}
