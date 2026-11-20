// The browsing state on disk: one versioned JSON document, read once at launch and written again after the store
// changes. The tab model matches desktop's, so sync can map it as a whole. Writes go to a temporary file first and
// replace the saved one in a single move, so a crash never leaves half a file. The same service prunes the snapshots
// and saved page states the tabs no longer show.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { DecodeError } from "../effect/errors.ts";
import { BrowserState } from "../effect/ports/browserState.ts";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Engine } from "../effect/ports/engine.ts";
import { Files } from "../effect/ports/files.ts";
import { Lifecycle, type AppStatus } from "../effect/ports/lifecycle.ts";
import { parseBrowserData, persistedBrowserData } from "./model.ts";
import type { BrowserData, JsonValue } from "./types.ts";

/** The saved browsing state, in the app's documents. */
export const STATE_FILE = "browser.json";

/** Where a write lands before it replaces the saved file. */
const DRAFT_FILE = `${STATE_FILE}.tmp`;

/** How long the store has to stay still before its state is written. */
export const SAVE_DELAY = 400;

/** How long the tabs have to stay still before the files they no longer show are deleted. */
export const PRUNE_DELAY = 5000;

/** What a failure says, looking through a tagged failure to the cause behind it. */
const reason = (error: { readonly cause?: unknown }): string => {
  const cause = error.cause;

  return cause instanceof Error ? cause.message : String(cause);
};

export class Persistence extends Context.Service<
  Persistence,
  {
    /**
     * Reads the saved state into the store and marks it ready. A missing file, an unreadable one and one that can't be
     * decoded are told apart in the diagnostics, and each starts fresh.
     */
    readonly load: () => Effect.Effect<void>;
    /** Writes the newest state now, when it changed since the last write. A failure is reported and stays dirty. */
    readonly flush: () => Effect.Effect<void>;
    /**
     * Follows the store and the app's state for the life of the scope, then loads the saved state. Changes are written
     * once the store has been still for a moment, and at once when Bay leaves the foreground.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/Persistence") {
  static readonly layer = Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const files = yield* Files;
      const browserState = yield* BrowserState;
      const engine = yield* Engine;
      const lifecycle = yield* Lifecycle;
      const diagnostics = yield* Diagnostics;

      // One writer: two writing the same temporary file at once lose one of them.
      const writer = yield* Semaphore.make(1);

      // Nothing is written before the saved state has been read: until then the store holds a placeholder.
      let loaded = false;
      // The store's changes, counted, and the count the file on disk has caught up with.
      let changes = 0;
      let written = 0;
      // Whether the last write failed. A run of failures is reported once, not once per change.
      let failing = false;

      /** Writes the state as it is now, when the file is behind it. */
      const writeLatest = Effect.gen(function* () {
        if (!loaded || written === changes) return;

        const target = changes;
        const data = yield* browserState.data();

        yield* files.write("document", DRAFT_FILE, JSON.stringify({ version: 2, ...persistedBrowserData(data) }));
        yield* files.move("document", DRAFT_FILE, STATE_FILE);

        written = target;
        failing = false;
      });

      // Once a write has started, it finishes: an interrupted one would leave the temporary file to the next.
      const save = Semaphore.withPermit(writer, Effect.uninterruptible(writeLatest)).pipe(
        Effect.catch((error) => {
          if (failing) return Effect.void;

          failing = true;

          return diagnostics.report({ operation: { name: "persistence.save", resource: STATE_FILE }, message: "Couldn't save browsing state.", cause: error });
        }),
      );

      /** Deletes the snapshots and saved page states that no tab shows any more. Failures are only worth a warning. */
      const prune = Effect.gen(function* () {
        const { tabs, archive } = yield* browserState.data();
        // Page views delete only their own previous snapshot, so closed, archived and remounted tabs leave files behind.
        const snapshots = [...tabs, ...archive].flatMap((tab) => (tab.snapshot ? [tab.snapshot] : []));
        // Saved page state is only worth keeping for open, non-private tabs; archived tabs reopen with their address.
        const states = tabs.filter((tab) => !tab.private).map((tab) => tab.id);

        yield* Effect.all(
          [
            engine.pruneSnapshots(snapshots).pipe(Effect.catch((error) => diagnostics.warn(`Couldn't prune tab snapshots: ${reason(error)}`))),
            engine.pruneTabStates(states).pipe(Effect.catch((error) => diagnostics.warn(`Couldn't prune saved tab states: ${reason(error)}`))),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.catch((error) => diagnostics.warn(`Couldn't prune tab files: ${reason(error)}`)));

      /** The saved state, or null when there is none. */
      const readSaved = (fallback: BrowserData) =>
        Effect.gen(function* () {
          const text = yield* files.read("document", STATE_FILE);

          if (text === null) {
            yield* diagnostics.warn("No saved browsing state; starting fresh.");

            return null;
          }

          return yield* Effect.try({
            // SAFETY: JSON.parse only ever yields JSON values; parseBrowserData checks their shape.
            try: () => parseBrowserData(JSON.parse(text) as JsonValue, fallback),
            catch: (cause) => new DecodeError({ operation: { name: "persistence.decode", resource: STATE_FILE }, cause }),
          });
        });

      const load = Effect.gen(function* () {
        const fallback = yield* browserState.data();

        const saved = yield* readSaved(fallback).pipe(
          Effect.catchTags({
            FileError: (error) =>
              Effect.as(
                diagnostics.report({
                  operation: { name: "persistence.read", resource: STATE_FILE },
                  message: "Couldn't read saved browsing state; starting fresh.",
                  cause: error,
                }),
                null,
              ),
            DecodeError: (error) =>
              Effect.as(
                diagnostics.report({ operation: error.operation, message: "Couldn't decode saved browsing state; starting fresh.", cause: error }),
                null,
              ),
          }),
        );

        // Marked first, so taking the saved state counts as a change and is written back in the current shape.
        loaded = true;

        yield* browserState.restore(saved);
      }).pipe(
        Effect.catch((error) =>
          diagnostics.report({ operation: { name: "persistence.load", resource: STATE_FILE }, message: "Couldn't load browsing state.", cause: error }),
        ),
      );

      /** What leaving and coming back to the foreground does to the state, in the order it always has. */
      const onStatus = (status: AppStatus) =>
        Effect.gen(function* () {
          if (!loaded) return;

          const now = yield* Clock.currentTimeMillis;

          if (status === "active") {
            yield* browserState.dispatch({ type: "archive-stale", now });

            return;
          }

          // Saved straight away: Bay may be killed in the background, and the start page timer needs this on next launch.
          if (status === "background") yield* browserState.dispatch({ type: "left", now });

          yield* save;
        }).pipe(
          Effect.catch((error) =>
            diagnostics.report({ operation: { name: "persistence.lifecycle" }, message: "Couldn't follow the app's state.", cause: error }),
          ),
        );

      return Persistence.of({
        load: () => load,
        flush: () => save,
        start: () =>
          Effect.gen(function* () {
            // A new change restarts the wait, so a burst of changes is written once.
            const saveLater = yield* FiberHandle.makeRuntime<never>();
            const pruneLater = yield* FiberHandle.makeRuntime<never>();
            // Work a native callback starts: it begins before the callback returns.
            const run = yield* FiberSet.makeRuntime<never>();

            const schedulePrune = () => void pruneLater(Effect.andThen(Effect.sleep(PRUNE_DELAY), prune));

            yield* browserState.subscribe((data, previous) => {
              if (!loaded) return;

              changes += 1;
              saveLater(Effect.andThen(Effect.sleep(SAVE_DELAY), save));

              if (data.tabs !== previous.tabs || data.archive !== previous.archive) schedulePrune();
            });

            yield* lifecycle.onChange((status) => void run(onStatus(status)));

            yield* load;

            // The files on disk may belong to tabs the saved state no longer has, whatever it held.
            schedulePrune();
          }),
      });
    }),
  );
}
