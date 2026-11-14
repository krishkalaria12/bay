import type { ConfirmOptions, ConfirmResult } from "@bay/desktop";

type QuitPreparation = {
  isCurrent(): boolean;
  prepareSync(): Promise<void>;
  flushSession(): Promise<void>;
  flushLive(): Promise<void>;
  flushTelemetry(): Promise<void>;
};

/** Sync may still change browser state while its current cycle finishes.
 * Capture final documents afterward, then checkpoint the latest telemetry
 * choice immediately before replying to native shutdown.
 */
export async function prepareApplicationQuit(owners: QuitPreparation): Promise<boolean> {
  if (!owners.isCurrent()) return false;
  await owners.prepareSync();

  if (!owners.isCurrent()) return false;
  await Promise.all([owners.flushSession(), owners.flushLive()]);

  if (!owners.isCurrent()) return false;
  await owners.flushTelemetry();

  return owners.isCurrent();
}

/** Saving before quitting failed. Refusing to quit until it works would leave Bay impossible to close, so say why and
 *  let the person choose. True to quit. */
export async function quitAnyway(error: Error, ask: (options: ConfirmOptions) => Promise<ConfirmResult>): Promise<boolean> {
  const reason = error instanceof Error ? error.message : String(error);

  try {
    const { confirmed } = await ask({
      title: "Bay couldn't save before quitting",
      message: `${reason}\n\nIf you quit anyway, changes since Bay last saved may be lost.`,
      confirmTitle: "Quit Anyway",
      cancelTitle: "Keep Bay Open",
      destructive: true,
    });

    return confirmed;
  } catch {
    return false;
  }
}
