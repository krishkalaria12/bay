// The shared Easels: the pages the app publishes to its website, and the keys that own them.
//
// The work is in components/library/sharingService.ts. This is where the app reaches it.
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { easelShareURL, SharingFailure, SharingService, useEaselShares } from "./sharingService";

export { easelShareURL, useEaselShares };

/** Reads the sharing records. */
export function startEaselShares() {
  void runDesktop(
    Effect.gen(function* () {
      const sharing = yield* SharingService;

      yield* sharing.start;
    }),
  );
}

// The app is told what went wrong in its own words: the sharing failure carries the message.
const asError = (error: Error | SharingFailure): Error => (error instanceof SharingFailure ? new Error(error.message) : error);

/** Publishes the Easel, and gives the link to share it by. */
export function publishEasel(easelId: string, snapshot: () => Promise<string>): Promise<string> {
  return runDesktop(
    Effect.gen(function* () {
      const sharing = yield* SharingService;

      return yield* sharing.publish(easelId, () => Effect.promise(snapshot));
    }),
  ).catch((error: Error | SharingFailure) => {
    throw asError(error);
  });
}

/** Stops sharing the Easel. */
export function stopSharingEasel(easelId: string): Promise<void> {
  return runDesktop(
    Effect.gen(function* () {
      const sharing = yield* SharingService;

      yield* sharing.stop(easelId);
    }),
  ).catch((error: Error | SharingFailure) => {
    throw asError(error);
  });
}
