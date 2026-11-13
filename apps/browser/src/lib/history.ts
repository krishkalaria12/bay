// The app's history: Chrome's own record of the pages that were visited, and the app's view of it.
//
// The work is in lib/historyService.ts. This is where the app reaches it: the runtime the work runs on, and the
// four things the app asks of it.
import * as Effect from "effect/Effect";
import { runDesktop, runtimeForStore } from "../effect/runtime";
import * as Cause from "effect/Cause";
import { type BrowserStore } from "../store/browserStore";
import { History } from "./historyService";

// The policy's own answers: which pages the app shows, and what a change Chrome reported does to the list.
export { applyHistoryChange, shownInHistory } from "./historyService";

/**
 * The history service a store reaches.
 *
 * The service itself is main's (lib/historyService.ts): one Chrome watcher and one set of views for the app, so a
 * store that asks for the history twice does not read Chrome twice.
 */
export type HistoryService = {
  /** The store this service is bound to. */
  readonly store: BrowserStore;
  /** Starts watching Chrome's history and reads each profile's. The answer gives it back. */
  start(): () => void;
  /** Stops watching Chrome's history. */
  stop(): void;
  /** Stops watching, and lets the store build a fresh service when it asks again. */
  dispose(): void;
  /** Reads every profile's history from Chrome again. */
  reload(): Promise<void>;
  /** Moves the app's old history.json into Chrome, and says what became of it. */
  migrate(options?: { now?: number; keepMs?: number }): Promise<"none" | "moved" | "kept">;
};

const services = new WeakMap<BrowserStore, HistoryService>();

/** The history service for a store. One store, one service: Chrome's watcher is registered once. */
export function createHistoryService(browser: BrowserStore): HistoryService {
  const existing = services.get(browser);

  if (existing) return existing;

  let epoch = 0;
  let stopWatching: (() => void) | undefined;
  const runtime = runtimeForStore(browser);

  const report = (cause: unknown) => {
    if (Cause.isCause(cause) && Cause.hasInterruptsOnly(cause)) return;

    if (cause instanceof Error && cause.message === "The authority runtime is disposed") return;
    console.error("The history service could not run", cause);
  };

  const stopping = Effect.gen(function* () {
    const history = yield* History;
    yield* history.stop;
  });

  const stop = () => {
    epoch++;
    stopWatching = undefined;

    if (services.get(browser) !== created) return;
    void runtime.runPromise(stopping).catch(report);
  };

  const created: HistoryService = {
    store: browser,
    start() {
      const existing = services.get(browser);

      if (existing && existing !== created) return existing.start();

      if (stopWatching) return stopWatching;
      services.set(browser, created);
      const run = ++epoch;
      void runtime
        .runPromise(
          Effect.gen(function* () {
            if (run !== epoch) return;
            const history = yield* History;
            yield* history.start;
          }),
        )
        .catch((cause) => {
          if (run !== epoch) return;
          stopWatching = undefined;
          report(cause);
        });

      const release = () => {
        if (stopWatching !== release) return;
        stop();
      };

      stopWatching = release;

      return release;
    },
    stop,
    dispose() {
      stop();

      if (services.get(browser) === created) services.delete(browser);
    },
    reload() {
      const run = epoch;

      return runtime.runPromise(
        Effect.gen(function* () {
          if (run !== epoch) return;
          const history = yield* History;
          yield* history.reload();
        }),
      );
    },
    migrate(options) {
      const run = epoch;

      return runtime.runPromise(
        Effect.gen(function* () {
          if (run !== epoch) return "none" as const;
          const history = yield* History;

          return yield* history.migrate(options ?? {});
        }),
      );
    },
  };

  services.set(browser, created);

  return created;
}

/** Starts the app's history: Chrome's changes are watched, and each profile's history is read. */
export const startHistory = (): Promise<void> =>
  runDesktop(
    Effect.gen(function* () {
      const history = yield* History;

      yield* history.start;
    }),
  );

/** Stops watching Chrome's history. */
export const stopHistory = (): Promise<void> =>
  runDesktop(
    Effect.gen(function* () {
      const history = yield* History;

      yield* history.stop;
    }),
  );

/** Re-reads every profile's history from Chrome (the dev harness, tests). */
export const reloadHistory = (): Promise<void> =>
  runDesktop(
    Effect.gen(function* () {
      const history = yield* History;

      yield* history.reload();
    }),
  );

/** Moves the app's old history.json into Chrome, and says what became of it. */
export const migrateHistoryFile = (now = Date.now(), { keepMs }: { keepMs?: number } = {}): Promise<"none" | "moved" | "kept"> =>
  runDesktop(
    Effect.gen(function* () {
      const history = yield* History;

      return yield* history.migrate({ now, keepMs });
    }),
  );
