import { AuthorityStore } from "../../effect/ports/store";
// Little Bay's lifetime: the windows left alone are put away, and the shortcut and menu bar button that open one from
// any app are registered.
//
// Both are the app's: the window and app events that say when a Little Bay was last used are heard once, the sweep
// is a job on the shared grid (it wakes the app only while there is a Little Bay to put away), and the shortcut is
// registered one choice at a time, so a slow answer to an older choice never shows over the newer one. Which windows
// go, when each was last used, and the routing of links into Little Bay stay plain (putAway.ts, actions.ts).
import { onAppEvent, onWindowEvent, setLittleBayHotKey, setLittleBayMenuBarItem, type AppEvent, type HotKeyStatus, type WindowEvent } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { Scheduler } from "../../effect/ports/scheduler";

import type { LittleBayShortcut } from "../../store/settings";
import { hotKeyCode, sameShortcut, useLittleBayAccess } from "./access";
import { PUT_AWAY_SWEEP_MS } from "./constants";
import { createLittleBayPutAway } from "./putAway";

// MARK: The port

/** The Mac could not do what was asked. */
export class LittleBayFailure extends TaggedError("LittleBayFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The Mac, as Little Bay reaches it. */
export class LittleBayEngine extends Context.Service<
  LittleBayEngine,
  {
    /** Registers a handler for the windows the Mac reports. The answer gives it back. */
    readonly onWindowEvent: (listener: (event: WindowEvent) => void) => Effect.Effect<() => void>;
    /** Registers a handler for the app's own events. The answer gives it back. */
    readonly onAppEvent: (listener: (event: AppEvent) => void) => Effect.Effect<() => void>;
    /** Registers the shortcut, or takes it away, and says whether it is the app's. */
    readonly setHotKey: (shortcut: LittleBayShortcut | null) => Effect.Effect<HotKeyStatus, LittleBayFailure>;
    /** Shows the menu bar button, or takes it away. */
    readonly setMenuBarItem: (on: boolean) => Effect.Effect<void, LittleBayFailure>;
  }
>()("bay/LittleBayEngine") {
  static readonly layer = Layer.succeed(LittleBayEngine)({
    onWindowEvent: (listener) =>
      Effect.sync(() => {
        const subscription = onWindowEvent(listener);

        return () => subscription.remove();
      }),
    onAppEvent: (listener) =>
      Effect.sync(() => {
        const subscription = onAppEvent(listener);

        return () => subscription.remove();
      }),
    setHotKey: (shortcut) =>
      Effect.tryPromise({
        try: () => setLittleBayHotKey(shortcut ? hotKeyCode(shortcut) : null, shortcut?.modifiers ?? []),
        catch: (cause) => new LittleBayFailure({ operation: { name: "littleBay.hotKey" }, cause }),
      }),
    setMenuBarItem: (on) =>
      Effect.tryPromise({
        try: () => setLittleBayMenuBarItem(on),
        catch: (cause) => new LittleBayFailure({ operation: { name: "littleBay.menuBar" }, cause }),
      }),
  });
}

// MARK: The service

export class LittleBayService extends Context.Service<
  LittleBayService,
  {
    /** Hears when Little Bays are used, puts the idle ones away, and registers the shortcut and the button. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/LittleBayService") {
  static readonly layer = Layer.effect(
    LittleBayService,
    Effect.gen(function* () {
      const useBrowser = yield* AuthorityStore;
      const engine = yield* LittleBayEngine;
      const scheduler = yield* Scheduler;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      const store = () => useBrowser.getState();
      const { noteAppEvent, noteWindowEvent, putAwayIdleLittleBays, putAwayNeeded } = createLittleBayPutAway(store);

      // MARK: The shortcut and the button

      // One registration at a time: the answers arrive in the order the choices were made.
      const registering = yield* Semaphore.make(1);

      // The choice the user made last: an answer to an older one does not show over it.
      let wanted: LittleBayShortcut | null = null;
      let menuBar = false;

      const register = (shortcut: LittleBayShortcut | null): Effect.Effect<void> =>
        registering.withPermits(1)(
          Effect.gen(function* () {
            // A newer choice was made while this one waited: it registers instead.
            if (!sameShortcut(wanted, shortcut)) return;

            const status = yield* engine.setHotKey(shortcut).pipe(
              Effect.catch((failure) =>
                diagnostics
                  .report({
                    operation: failure.operation,
                    message: failure.message,
                    cause: failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause)),
                  })
                  .pipe(Effect.as<HotKeyStatus>(shortcut ? "taken" : "off")),
              ),
            );

            if (sameShortcut(wanted, shortcut)) useLittleBayAccess.setState({ status });
          }),
        );

      const apply = (): void => {
        const settings = store().settings;
        const next = settings.littleBayShortcut ?? null;

        // Nothing is registered at launch: the chosen shortcut registers then, as every new choice does.
        if (!sameShortcut(next, wanted)) {
          wanted = next;

          void Effect.runFork(Effect.forkIn(register(next), scope));
        }

        if (settings.littleBayMenuBarItem !== menuBar) {
          menuBar = settings.littleBayMenuBarItem;

          void Effect.runFork(Effect.forkIn(engine.setMenuBarItem(menuBar).pipe(Effect.ignore), scope));
        }
      };

      // MARK: Starting

      let started = false;

      const start = Effect.gen(function* () {
        if (started) return;

        started = true;

        const removeWindows = yield* engine.onWindowEvent(noteWindowEvent);
        const removeApp = yield* engine.onAppEvent(noteAppEvent);

        yield* scheduler.every({
          every: PUT_AWAY_SWEEP_MS,
          run: Effect.sync(() => void putAwayIdleLittleBays()),
          needed: putAwayNeeded,
          watch: (changed) =>
            useBrowser.subscribe((s, prev) => {
              if (s.windows !== prev.windows || s.settings !== prev.settings) changed();
            }),
        });

        apply();

        const stopAccess = useBrowser.subscribe((s, prev) => {
          if (s.settings.littleBayShortcut !== prev.settings.littleBayShortcut || s.settings.littleBayMenuBarItem !== prev.settings.littleBayMenuBarItem)
            apply();
        });

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            removeWindows();
            removeApp();
            stopAccess();
            started = false;
          }),
        );
      });

      return LittleBayService.of({ start });
    }),
  );
}
