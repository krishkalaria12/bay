import type { BrowserStore } from "../store/browser";

let owner: BrowserStore | undefined;
let generation = 0;

/** Sync writes only to the store owned by the running coordinator or legacy app. */
export function configureSyncStore(store: BrowserStore): () => void {
  owner = store;
  const current = ++generation;
  return () => {
    if (generation === current) {
      owner = undefined;
      generation++;
    }
  };
}
export function syncStore(): BrowserStore {
  if (!owner) throw new Error("Sync engine has no active owner");
  return owner;
}
export const syncGeneration = () => generation;
export function assertSyncGeneration(current: number): void {
  if (!owner || generation !== current) throw new Error("Sync owner stopped");
}
