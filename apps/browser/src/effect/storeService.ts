// The app's services, started for one store.
//
// A workflow that the platform's coordinator owns is started once per app instance and stopped when that instance
// goes. The services themselves are the desktop runtime's (effect/runtimeLayer.ts): this only pairs an imperative
// start with an idempotent stop, so a store's owner can reach them the way the rest of the coordinator does.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { BrowserStore } from "../store/browserStore";
import { captureException } from "../telemetry/errors";
import { AuthorityRuntimeDisposed, runtimeForStore, type AppServices } from "./runtime";

/** Where a service that could not be started or stopped is reported: once, with every other failure. */
const report = (message: string) => (cause: unknown) => {
  if (cause instanceof AuthorityRuntimeDisposed || (Cause.isCause(cause) && Cause.hasInterruptsOnly(cause))) return;
  const failure = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  const error = failure instanceof Error ? failure : new Error(String(failure));

  captureException(error, "console");
  console.error(message, error);
};

/**
 * Starts a service for a store, and gives back its stop.
 *
 * The stop is idempotent, and it is safe before the start has settled: the start then does nothing, so a stopped
 * service never runs behind its owner. A start that fails is reported, and `onFailed` tells the caller to forget
 * the stop it handed out, so the next caller can start a fresh one.
 */
export function startStoreService(
  store: BrowserStore,
  message: string,
  start: Effect.Effect<void, never, AppServices>,
  stop: Effect.Effect<void, never, AppServices>,
  onFailed: () => void = () => {},
): () => void {
  let stopped = false;
  const runtime = runtimeForStore(store);

  void runtime
    .runPromise(
      Effect.gen(function* () {
        if (stopped) return;

        yield* start;
      }),
    )
    .catch((cause) => {
      if (stopped) return;
      stopped = true;
      report(message)(cause);
      onFailed();
    });

  return () => {
    if (stopped) return;
    stopped = true;

    void runtime.runPromise(stop).catch(report(message));
  };
}
