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
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { AuthorityStore } from "../effect/ports/store";
import type { AppServices } from "../effect/runtime";
import { useBrowser, type BrowserState, type BrowserStore } from "../store/browserStore";
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
      const browser = (yield* AuthorityStore).store;
      const engine = yield* ProfileEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The profiles whose data could not be deleted: they stay queued for the next launch.
      const failed = new Set<string>();

      // The cleanup is asked for by the store: a profile was deleted, or the queue changed.
      const requests = yield* Queue.unbounded<void>();

      const deleteOne = (profile: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = browser.getState();

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

          browser.getState().profileDataDeleted(profile);
        });

      const drain = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (;;) {
            const profile = browser.getState().orphanedProfileData.find((e) => !failed.has(e));

            if (profile === undefined) return;

            // The web views have to close before the profile's data can go.
            yield* Effect.sleep(Duration.millis(PROFILE_CLOSE_DELAY_MS));

            yield* deleteOne(profile);
          }
        });

      // The delete runs in a scope of its own, so a stop cancels the wait the queue is in and a start opens a
      // fresh one. The app's scope still closes it.
      let workScope: ReturnType<typeof Scope.forkUnsafe> | undefined;

      const open = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (workScope) return;

          const opening = Scope.forkUnsafe(scope);

          workScope = opening;
          yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(requests), () => drain())), opening);
        });

      const close = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const closing = workScope;

          workScope = undefined;

          if (closing) yield* Scope.close(closing, Exit.succeed(undefined));
        });

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

          return open();
        }

        const stopSubscription = browser.subscribe(onStore);

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

          yield* open();
        });
      });

      const stop = Effect.gen(function* () {
        stopWatching?.();
        yield* close();
      });

      return ProfileCleanup.of({ start, stop });
    }),
  );
}

/**
 * The runtime the cleanup runs on. It is loaded when the cleanup starts, not when this module is: the policy is
 * plain, and the app's runtime is not.
 */
const run = async <A, E>(browser: BrowserStore, program: Effect.Effect<A, E, AppServices>): Promise<A> => {
  const { runForStore } = await import("../effect/runtime");

  return runForStore(browser, program);
};

/**
 * The profile cleanup a store reaches.
 *
 * The cleanup itself is the service above: one queue and one subscription for the app, so a store that asks for the
 * cleanup twice does not delete a profile's data twice.
 */
export type ProfileDataCleanup = {
  /** The store this cleanup is bound to. */
  readonly store: BrowserStore;
  /** Starts the cleanup: the profiles still queued are deleted, and the queue is watched. The answer gives it back. */
  start(): () => void;
  /** Stops watching the queue. */
  stop(): void;
  /** Stops watching, and lets the store build a fresh cleanup when it asks again. */
  dispose(): void;
};

const cleanups = new WeakMap<BrowserStore, ProfileDataCleanup>();

/** The profile cleanup for a store. One store, one cleanup: the queue is watched once. */
export function createProfileDataCleanup(browser: BrowserStore): ProfileDataCleanup {
  const existing = cleanups.get(browser);

  if (existing) return existing;

  // Each start's own stop: the stop a start gave back is inert once another start has replaced it.
  let started = 0;

  const created: ProfileDataCleanup = {
    store: browser,
    start() {
      const own = ++started;

      void run(
        browser,
        Effect.gen(function* () {
          const cleanup = yield* ProfileCleanup;

          yield* cleanup.start;
        }),
      );

      return () => {
        if (own === started) created.stop();
      };
    },
    stop() {
      started++;
      void run(
        browser,
        Effect.gen(function* () {
          const cleanup = yield* ProfileCleanup;

          yield* cleanup.stop;
        }),
      );
    },
    dispose() {
      if (cleanups.get(browser) === created) cleanups.delete(browser);
      created.stop();
    },
  };

  cleanups.set(browser, created);

  return created;
}

/** Starts the app's profile cleanup: the profiles still queued are deleted, and the queue is watched. */
export const startProfileDataCleanup = (): (() => void) => createProfileDataCleanup(useBrowser).start();
