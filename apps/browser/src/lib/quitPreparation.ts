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
