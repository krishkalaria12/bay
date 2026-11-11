// A deleted profile's engine data goes once its web views have closed. What can't be deleted stays queued (in
// session.json) and is tried again at the next launch.
//
// The work is a program: the cleanup waits for the views to close, then asks Chrome to delete the profile's data,
// and keeps what it could not delete queued for the next launch.
import { deleteProfileData } from "@bay/chromium";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { engineIdOf } from "../store/spaces";
import { PROFILE_CLOSE_DELAY_MS } from "./constants";

/** Chrome could not delete the profile's data. */
export class ProfileCleanupError extends TaggedError("ProfileCleanupError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** Chrome's profiles, as the app reaches them. */
export class ProfileEngine extends Context.Service<
  ProfileEngine,
  {
    /** Deletes the profile's engine data, and says what is left of it. */
    readonly delete: (engine: string) => Effect.Effect<string[], ProfileCleanupError>;
  }
>()("bay/ProfileEngine") {
  static readonly layer = Layer.succeed(ProfileEngine)({
    delete: (engine) =>
      Effect.tryPromise({
        try: () => deleteProfileData(engine),
        catch: (cause) => new ProfileCleanupError({ operation: { name: "profile.delete", resource: engine }, cause }),
      }),
  });
}

export class ProfileCleanup extends Context.Service<
  ProfileCleanup,
  {
    /** Starts the cleanup: the profiles still queued are deleted, and the queue is watched. */
    readonly start: Effect.Effect<void>;
    /** Stops watching the queue. */
    readonly stop: Effect.Effect<void>;
  }
>()("bay/ProfileCleanup") {
  static readonly layer = Layer.effect(
    ProfileCleanup,
    Effect.gen(function* () {
      const engine = yield* ProfileEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The profiles whose data could not be deleted: they stay queued for the next launch.
      const failed = new Set<string>();

      // The cleanup is asked for by the store: a profile was deleted, or the queue changed.
      const requests = yield* Queue.unbounded<void>();

      const deleteOne = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = useBrowser.getState();

          if (!state.orphanedProfileData.includes(profile)) return;

          // The profile is back (it was restored before its data went): nothing to delete.
          if (Object.values(state.spaces).some((space) => engineIdOf(space) === profile)) {
            state.profileDataDeleted(profile);

            return;
          }

          const remaining = yield* engine.delete(profile).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                const cause = error.cause instanceof Error ? error.cause : new Error(String(error.cause));

                void diagnostics.report({
                  operation: { name: "profile.delete", resource: profile },
                  message: "Chrome refused to delete the profile's data",
                  cause,
                });

                return [String(error.cause)];
              }),
            ),
          );

          if (remaining.length) {
            failed.add(profile);
            yield* diagnostics.report({
              operation: { name: "profile.delete", resource: profile },
              message: `Chrome kept ${remaining.join(", ")}`,
            });

            return;
          }

          useBrowser.getState().profileDataDeleted(profile);
        });

      const drain = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (;;) {
            const profile = useBrowser.getState().orphanedProfileData.find((e) => !failed.has(e));

            if (profile === undefined) return;

            // The web views have to close before the profile's data can go.
            yield* Effect.sleep(Duration.millis(PROFILE_CLOSE_DELAY_MS));

            yield* deleteOne(profile);
          }
        });

      // The cleanup runs here, in the app's scope: it stops when the app does.
      yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(requests), () => drain())));

      const onStore = (s: BrowserState, prev: BrowserState) => {
        if (s.orphanedProfileData !== prev.orphanedProfileData) Queue.offerUnsafe(requests, undefined);
      };

      // The subscription the app's cleanup holds, and the stop that gives it back.
      let stopWatching: (() => void) | undefined;

      const start = Effect.suspend((): Effect.Effect<void> => {
        // Every launch tries again: what failed last time is tried now.
        failed.clear();

        if (stopWatching) {
          // The profiles still queued from the last launch are deleted now.
          Queue.offerUnsafe(requests, undefined);

          return Effect.void;
        }

        const stopSubscription = useBrowser.subscribe(onStore);

        stopWatching = () => {
          stopSubscription();
          stopWatching = undefined;
        };

        return Effect.gen(function* () {
          // The app's scope owns the subscription.
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => stopWatching?.()),
          );

          // The profiles still queued from the last launch are deleted now.
          Queue.offerUnsafe(requests, undefined);
        });
      });

      const stop = Effect.sync(() => stopWatching?.());

      return ProfileCleanup.of({ start, stop });
    }),
  );
}
