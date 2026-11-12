// The app's bookmarks: Chrome's own tree of them, and the app's tree of the same.
//
// The work is in lib/bookmarkService.ts. This is where the app reaches it: the runtime the work runs on, and the
// four things the app asks of it.
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { Bookmarks, showCachedTrees } from "./bookmarkService";

/**
 * Starts the app's bookmarks: the trees Chrome confirmed last show at once, and Chrome's own are read.
 *
 * The cache shows before the runtime is ready: it is what the user sees while Chrome is asked.
 */
export const startBookmarks = (): Promise<void> => {
  showCachedTrees();

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
