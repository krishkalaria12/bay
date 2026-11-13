// The app's saving, as the Effect runtime reaches it.
//
// The saving itself is lib/persist.ts: one owner per store, one subscription to that store, one timer and one quit
// handshake. This is the service the runtime starts, and it reaches that owner; the coordinator's runtime
// (runtime/services.ts) reaches the same one for the same store, so a session is never written twice.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { liveFoldersDocument } from "../activity/activityStore";
import { AuthorityStore } from "../effect/ports/store";
import { createBrowserPersistence, startPersistence as startBrowserPersistence } from "./persist";
import type { SavedDocument } from "./savedDocument";

// The documents other stores keep, saved with the session's own: one timer, the same retry, and the same quit.
const OTHER_DOCS: readonly SavedDocument[] = [liveFoldersDocument];

export { createBrowserPersistence, createPersistence, flushPersistence, resumePersistence } from "./persist";

export type { PersistenceOwner } from "./persist";

/** Starts the app's saving: the session, the downloads, and the live folders' own document. */
export const startPersistence = (): (() => void) => startBrowserPersistence({ documents: OTHER_DOCS });

export class Persistence extends Context.Service<
  Persistence,
  {
    /** Starts the app's saving in the app's scope, and gives it back when the scope closes. */
    readonly start: Effect.Effect<void>;
  }
>()("bay/Persistence") {
  static readonly layer = Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const browser = (yield* AuthorityStore).store;

      return Persistence.of({
        start: Effect.suspend(() => {
          const owner = createBrowserPersistence({ store: browser, restoreSession: false });

          // The app's scope owns the saving: it stops when the scope closes.
          return Scope.addFinalizer(
            scope,
            Effect.sync(() => owner.dispose()),
          );
        }),
      });
    }),
  );
}
