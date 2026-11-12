// The app's history: Chrome's own record of the pages that were visited, and the app's view of it.
//
// The work is in lib/historyService.ts. This is where the app reaches it: the runtime the work runs on, and the
// four things the app asks of it.
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { History } from "./historyService";

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
