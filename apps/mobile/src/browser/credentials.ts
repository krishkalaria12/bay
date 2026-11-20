/**
 * Saved logins (B20): what the server's HTTP sign-in asks for, stored per site so the next challenge is answered
 * silently. A single versioned JSON document (`bay-saved-logins`) in the secure store, like the browser's own
 * `browser.json`. Credentials never join the tab model, history or anything persisted to disk in the clear.
 *
 * Private tabs never read or write here: a private page's credentials stay in the private session, as its history
 * does. The pure format lives in `./logins` so it can be tested without the secure store's native module, and the
 * secure store itself is reached through its port, which loads the native module on first use.
 *
 * Every change reads the whole document, edits it and writes it back, so changes take turns: an auto-save while
 * Settings forgets one would otherwise lose one of the two.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { SecureStore, type SecureStoreError } from "../effect/ports/secureStore.ts";
import { formatSavedLogins, parseSavedLogins, type SavedLogin } from "./logins.ts";

const KEY = "bay-saved-logins";

export type { SavedLogin };

export class Logins extends Context.Service<
  Logins,
  {
    /** Every saved login, in the order they were saved. */
    readonly list: () => Effect.Effect<readonly SavedLogin[], SecureStoreError>;
    /** The saved login for an origin (scheme + host + port), if any. */
    readonly find: (origin: string) => Effect.Effect<SavedLogin | null, SecureStoreError>;
    /** Saves (or replaces) a login for an origin + username. */
    readonly save: (login: SavedLogin) => Effect.Effect<void, SecureStoreError>;
    /** Forgets one saved login. */
    readonly forget: (origin: string, username: string) => Effect.Effect<void, SecureStoreError>;
  }
>()("bay/Logins") {
  static readonly layer = Layer.effect(
    Logins,
    Effect.gen(function* () {
      const store = yield* SecureStore;
      // One change at a time, in the order they were asked for.
      const writing = yield* Semaphore.make(1);

      const list = () => Effect.map(store.read(KEY), parseSavedLogins);

      /**
       * Reads the document, edits it and writes it back while holding the only permit. A change the user asked for
       * lands even when the sheet that asked closes: once asked, it can't be interrupted.
       */
      const change = (edit: (logins: readonly SavedLogin[]) => readonly SavedLogin[]) =>
        Effect.uninterruptible(
          writing.withPermit(
            Effect.gen(function* () {
              const logins = yield* list();

              yield* store.write(KEY, formatSavedLogins(edit(logins)));
            }),
          ),
        );

      // Logins are keyed by origin + username: a save replaces the one with the same pair, a forget drops it.
      const isOther = (origin: string, username: string) => (login: SavedLogin) => !(login.origin === origin && login.username === username);

      return Logins.of({
        list,
        find: (origin) => Effect.map(list(), (logins) => logins.find((login) => login.origin === origin) ?? null),
        save: (login) => change((logins) => [...logins.filter(isOther(login.origin, login.username)), login]),
        forget: (origin, username) => change((logins) => logins.filter(isOther(origin, username))),
      });
    }),
  );
}

/** Every saved login, for the list in Settings. */
export const savedLogins: Effect.Effect<readonly SavedLogin[], SecureStoreError, Logins> = Logins.use((logins) => logins.list());

/**
 * Forgets one login and reads the list back for Settings. A forget that fails is reported, and the list still shows
 * what is really saved.
 */
export const forgetLogin = (origin: string, username: string): Effect.Effect<readonly SavedLogin[], SecureStoreError, Logins | Diagnostics> =>
  Effect.gen(function* () {
    const logins = yield* Logins;
    const diagnostics = yield* Diagnostics;

    yield* logins
      .forget(origin, username)
      .pipe(Effect.catch((error) => diagnostics.report({ operation: error.operation, message: "The saved login could not be forgotten", cause: error })));

    return yield* logins.list();
  });
