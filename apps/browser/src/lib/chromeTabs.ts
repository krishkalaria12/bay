// The engine's tab strips, as the app starts them.
//
// The service that reads the engine's transactions lives in the app's runtime (lib/engineTabs.ts). This is where
// the app reaches it: the reconciliation starts when a window shows a page, and the engine's transactions are read
// from then on. On the shared host the coordinator owns the store the strips follow, so it starts them itself
// (shellBridge.ts) and a window's page cards leave them be.
import * as Effect from "effect/Effect";
import { desktopRuntime } from "../effect/runtime";
import { captureException } from "../telemetry/errors";
import { EngineTabsService } from "./engineTabs";
import { pageFactsInCoordinator } from "./pageFactOwnership";

/**
 * Starts the reconciliation: the engine's transactions are read, and the strips are read once.
 *
 * The service owns the listener and the "started once" rule: a second call finds the engine already read and does
 * nothing. The listener is given back when the app's runtime closes. A shared host's window has no runtime of the
 * app's: its coordinator reconciles the strips.
 */
export function startChromeTabs() {
  if (pageFactsInCoordinator()) return;

  void desktopRuntime
    .runPromise(
      Effect.gen(function* () {
        const tabs = yield* EngineTabsService;

        yield* tabs.start;
      }),
    )
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      captureException(error, "console");
      console.error("The engine's tab strips could not be reconciled", error);
    });
}

/** Gives the engine's transactions back and stops the reconciliation. */
export const disposeChromeTabs = (): Promise<void> =>
  desktopRuntime.runPromise(
    Effect.gen(function* () {
      const tabs = yield* EngineTabsService;

      yield* tabs.stop;
    }),
  );
