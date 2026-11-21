// The app's bookmarks: Chrome's own tree of them, and the app's tree of the same.
//
// The work is in lib/bookmarkService.ts. This is where the app reaches it: the runtime the work runs on, and the
// four things the app asks of it.
import * as Effect from "effect/Effect";
import { runDesktop, runtimeForStore } from "../effect/runtime";
import * as Cause from "effect/Cause";
import { useBrowser, type BrowserStore } from "../store/browserStore";
import { Bookmarks, showCachedTrees } from "./bookmarkService";

/**
 * The bookmark service a store reaches.
 *
 * The service itself is main's (lib/bookmarkService.ts): one Chrome watcher and one set of trees for the app, so a
 * store that asks for the bookmarks twice does not read Chrome twice.
 */
export type BookmarksService = {
  /** The store this service is bound to. */
  readonly store: BrowserStore;
  /** Starts the app's bookmarks and reads Chrome's own. The answer gives it back. */
  start(): () => void;
  /** Stops watching Chrome's bookmarks. */
  stop(): void;
  /** Stops watching, and lets the store build a fresh service when it asks again. */
  dispose(): void;
  /** Reads every profile's bookmarks from Chrome again. */
  reload(): Promise<void>;
  /** Moves the app's old bookmarks.json into Chrome, and says what became of it. */
  migrate(options?: { keepMs?: number }): Promise<"none" | "moved" | "kept">;
};

const services = new WeakMap<BrowserStore, BookmarksService>();

/** The bookmark service for a store. One store, one service: Chrome's watcher is registered once. */
export function createBookmarksService(browser: BrowserStore): BookmarksService {
  const existing = services.get(browser);

  if (existing) return existing;

  let epoch = 0;
  let stopWatching: (() => void) | undefined;
  const runtime = runtimeForStore(browser);

  const report = (cause: unknown) => {
    if (Cause.isCause(cause) && Cause.hasInterruptsOnly(cause)) return;

    if (cause instanceof Error && cause.message === "The authority runtime is disposed") return;
    console.error("The bookmarks service could not run", cause);
  };

  const stopping = Effect.gen(function* () {
    const bookmarks = yield* Bookmarks;
    yield* bookmarks.stop;
  });

  const stop = () => {
    epoch++;
    stopWatching = undefined;

    if (services.get(browser) !== created) return;
    void runtime.runPromise(stopping).catch(report);
  };

  const created: BookmarksService = {
    store: browser,
    start() {
      const existing = services.get(browser);

      if (existing && existing !== created) return existing.start();

      if (stopWatching) return stopWatching;
      services.set(browser, created);
      const run = ++epoch;
      showCachedTrees(browser);
      void runtime
        .runPromise(
          Effect.gen(function* () {
            if (run !== epoch) return;
            const bookmarks = yield* Bookmarks;
            yield* bookmarks.start;
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
          const bookmarks = yield* Bookmarks;
          yield* bookmarks.reload();
        }),
      );
    },
    migrate(options) {
      const run = epoch;

      return runtime.runPromise(
        Effect.gen(function* () {
          if (run !== epoch) return "none" as const;
          const bookmarks = yield* Bookmarks;

          return yield* bookmarks.migrate(options ?? {});
        }),
      );
    },
  };

  services.set(browser, created);

  return created;
}

/**
 * Starts the app's bookmarks: the trees Chrome confirmed last show at once, and Chrome's own are read.
 *
 * The cache shows before the runtime is ready: it is what the user sees while Chrome is asked.
 */
export const startBookmarks = (): Promise<void> => {
  showCachedTrees(useBrowser);

  return runDesktop(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.start;
    }),
  );
};

/** Stops watching Chrome's bookmarks. */
export const stopBookmarks = (): Promise<void> =>
  runDesktop(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.stop;
    }),
  );

/** Reads every profile's bookmarks from Chrome again; resolves when they're read (the dev harness, tests). */
export const reloadBookmarks = (): Promise<void> =>
  runDesktop(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      yield* bookmarks.reload();
    }),
  );

/** Moves the app's old bookmarks.json into Chrome, and says what became of it. */
export const migrateBookmarksFile = ({ keepMs }: { keepMs?: number } = {}): Promise<"none" | "moved" | "kept"> =>
  runDesktop(
    Effect.gen(function* () {
      const bookmarks = yield* Bookmarks;

      return yield* bookmarks.migrate({ keepMs });
    }),
  );
