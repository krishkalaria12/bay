// What Settings › Sync shows: whether the phone syncs, how the last cycle went, the devices, their tabs, and a pairing
// under way. The sync service (service.ts) writes it; the screens read it.
import { create } from "zustand";

import type { RemoteTabs, SyncedDevice, SyncTypes } from "./engine.ts";

export type SyncStatus =
  /** Not syncing: no key on this phone. */
  | "off"
  | "syncing"
  | "synced"
  /** Joined, but the computer hasn't listed a profile yet. */
  | "waiting"
  /** The relay didn't answer; the next cycle tries again. */
  | "offline"
  | "failed";

/** A pairing under way: the code this phone shows and the digits to compare, or how it ended. */
export type Pairing = { state: "starting" } | { state: "waiting"; code: string; digits: string } | { state: "expired" } | { state: "failed" };

export interface SyncView {
  status: SyncStatus;
  lastSyncedAt: number | null;
  devices: SyncedDevice[];
  remoteTabs: RemoteTabs[];
  types: SyncTypes;
  pairing: Pairing | null;
}

export const useSyncStore = create<SyncView>(() => ({
  status: "off",
  lastSyncedAt: null,
  devices: [],
  remoteTabs: [],
  types: { tabs: true, bookmarks: true, history: true },
  pairing: null,
}));
