// The language on disk: the one the user picked, read once at launch and written again after each pick. The language
// shown lives in `./index.ts`, a plain store the screens read synchronously; this service only feeds it. A pick in
// Settings interrupts a launch read still on its way, so the read can never undo the pick.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { Diagnostics } from "../effect/ports/diagnostics.ts";
import { Files } from "../effect/ports/files.ts";
import { Lifecycle } from "../effect/ports/lifecycle.ts";
import { localeDocument, parseLocaleDocument } from "./document.ts";
import { detectLocale, onPick, refreshDeviceLocale, showLocale, type Locale } from "./index.ts";

/** The saved language, in the app's documents. */
export const LOCALE_FILE = "locale.json";

/** Where a write lands before it replaces the saved file. */
const DRAFT_FILE = `${LOCALE_FILE}.tmp`;

export class LocaleService extends Context.Service<
  LocaleService,
  {
    /** Reads the saved language and shows it, or the device's own when there is none or it can't be read. */
    readonly load: () => Effect.Effect<void>;
    /** Keeps a pick for the next launch: a language is written, null forgets the saved one. Picks land in order. */
    readonly save: (locale: Locale | null) => Effect.Effect<void>;
    /**
     * Reads the saved language and follows picks and the device's language for the life of the scope. The read runs
     * in the background: a pick that comes first interrupts it.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("bay/LocaleService") {
  static readonly layer = Layer.effect(
    LocaleService,
    Effect.gen(function* () {
      const files = yield* Files;
      const lifecycle = yield* Lifecycle;
      const diagnostics = yield* Diagnostics;

      // One writer, taken in the order the picks came: two writing the same temporary file at once lose one.
      const writer = yield* Semaphore.make(1);

      const load = Effect.gen(function* () {
        const text = yield* files
          .read("document", LOCALE_FILE)
          .pipe(
            Effect.catch((error) =>
              Effect.as(
                diagnostics.report({ operation: { name: "locale.read", resource: LOCALE_FILE }, message: "Couldn't read the saved language.", cause: error }),
                null,
              ),
            ),
          );

        const stored = text === null ? null : parseLocaleDocument(text);

        if (stored) {
          showLocale(stored, stored);

          return;
        }

        const device = yield* Effect.promise(() => detectLocale());

        showLocale(null, device);
      });

      const save = (locale: Locale | null) =>
        Semaphore.withPermit(
          writer,
          Effect.gen(function* () {
            if (!locale) {
              yield* files.delete("document", LOCALE_FILE);

              return;
            }

            yield* files.write("document", DRAFT_FILE, localeDocument(locale));
            yield* files.move("document", DRAFT_FILE, LOCALE_FILE);
          }).pipe(Effect.uninterruptible),
        ).pipe(
          Effect.catch((error) =>
            diagnostics.report({ operation: { name: "locale.save", resource: LOCALE_FILE }, message: "Couldn't save the chosen language.", cause: error }),
          ),
        );

      return LocaleService.of({
        load: () => load,
        save,
        start: () =>
          Effect.gen(function* () {
            const loading = yield* FiberHandle.make();
            // Work a pick starts: it begins before setLocale returns.
            const run = yield* FiberSet.makeRuntime<never>();

            // A language changed in the phone's settings while Bay was away shows on return, unless one was picked.
            yield* lifecycle.onChange((status) => {
              if (status === "active") refreshDeviceLocale();
            });

            yield* Effect.acquireRelease(
              Effect.sync(() =>
                onPick((locale) => {
                  // The pick is already showing, so a read still on its way is out of date: it stops here.
                  run(FiberHandle.clear(loading));
                  run(save(locale));
                }),
              ),
              (stop) => Effect.sync(stop),
            );

            yield* FiberHandle.run(loading, load);
          }),
      });
    }),
  );
}
