// The quit can be called off by beforeunload. Each attempt keeps its own identity so a late disk or dialog
// completion cannot authorize shutdown after the app has resumed.
import { confirm, replyToTerminate } from "@bay/desktop";
import { prepareSyncForQuit, resumeSyncAfterQuit } from "../sync/engine";
import { prepareTelemetryForQuit, resumeTelemetryAfterQuit } from "../telemetry/usage";
import { flushPersistence, resumePersistence } from "./persistenceService";
import type { PersistenceOwner } from "./persist";
import { prepareApplicationQuit, quitAnyway } from "./quitPreparation";

let quitting = false;
let attempt = 0;

export const isQuitting = () => quitting;

/** Checkpoint accepted work and wait for disk acknowledgements before answering native termination. */
export const beginQuit = async (persistence?: Pick<PersistenceOwner, "flush">): Promise<void> => {
  quitting = true;
  const current = ++attempt;
  const isCurrent = () => quitting && current === attempt;

  try {
    const prepared = await prepareApplicationQuit({
      isCurrent,
      prepareSync: prepareSyncForQuit,
      flushSession: () => (persistence ? persistence.flush({ final: true }) : flushPersistence({ final: true })),
      // The persistence owner includes Live, or its caller combines the separate Live owner with this flush.
      flushLive: () => Promise.resolve(),
      flushTelemetry: prepareTelemetryForQuit,
    });

    if (prepared && isCurrent()) await replyToTerminate(true);
  } catch (error) {
    console.error("Couldn't save app data before quitting", error);

    if (!isCurrent()) return;
    const quit = await quitAnyway(error instanceof Error ? error : new Error(String(error)), confirm);

    if (isCurrent()) await replyToTerminate(quit);
  }
};

/** Resume the same owners after a cancelled quit, invalidating completions from the previous attempt first. */
export const cancelQuit = (persistence?: Pick<PersistenceOwner, "resume">): void => {
  quitting = false;
  attempt++;
  resumeSyncAfterQuit();

  if (persistence) persistence.resume();
  else resumePersistence();

  void resumeTelemetryAfterQuit().catch((error) => console.error("Couldn't restore telemetry after cancelled quit", error));
};
