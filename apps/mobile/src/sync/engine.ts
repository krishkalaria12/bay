// The phone's sync cycle, as the computer's (apps/browser/src/sync/engine.ts) runs its own over the same chain: the
// app's scope first, where every device names itself and the computer lists its profiles, then the scope of the
// computer's default profile, where the open tabs, bookmarks and history are. Pure: the store, the relay and the
// saving come in as functions, so the tests sync a phone with a stand-in computer.
import type { JsonValue } from "@bay/sync/src/canon.ts";
import { Clock } from "@bay/sync/src/hlc.ts";
import { emptyScope, syncScope, visible, type Adapter, type ScopeState, type Transport } from "@bay/sync/src/scope.ts";
import * as v from "valibot";

import type { BrowserAction } from "../store/model.ts";
import type { BrowserData } from "../store/types.ts";
import {
  bookmarksAdapter,
  deviceAdapter,
  DeviceRecordSchema,
  deviceTabsAdapter,
  DeviceTabsSchema,
  HISTORY_WINDOW_MS,
  historyAdapter,
  type DeviceTabs,
} from "./adapters.ts";

/** Where every device names itself and the computer lists its profiles. */
export const APP_SCOPE = "app";

/** What the phone syncs; each can be turned off in Settings › Sync. */
export type SyncTypes = { tabs: boolean; bookmarks: boolean; history: boolean };

export const SYNC_TYPES = ["tabs", "bookmarks", "history"] as const;

export const defaultTypes = (): SyncTypes => ({ tabs: true, bookmarks: true, history: true });

/** The phone's sync, saved between launches. The chain's key isn't here: it's in the secure store. */
export interface SyncDoc {
  v: 1;
  deviceId: string;
  clock: string | null;
  /** The computer's default profile's sync id, once its record has come: its scope is `p:<profile>`. */
  profile: string | null;
  scopes: Record<string, ScopeState>;
  types: SyncTypes;
  lastSyncedAt: number | null;
}

export const newDoc = (deviceId: string): SyncDoc => ({ v: 1, deviceId, clock: null, profile: null, scopes: {}, types: defaultTypes(), lastSyncedAt: null });

const ProfileSchema = v.object({ n: v.string(), d: v.optional(v.literal(true)) });

/** The computer's: a history record older than the window is gone everywhere, not deleted. */
export const historyExpired = (key: string, value: JsonValue | null, now: number): boolean => {
  if (!key.startsWith("h:") || !value) return false;

  const parsed = v.safeParse(v.object({ vt: v.array(v.number()) }), value);

  return parsed.success && Math.max(0, ...parsed.output.vt) < now - HISTORY_WINDOW_MS;
};

export interface CycleDeps {
  transport: Transport;
  /** This phone's name, as the computer lists it. */
  deviceName: () => string;
  data: () => BrowserData;
  /** Whether the browsing state has been read from disk: before, it's empty, which would read as everything deleted. */
  ready: () => boolean;
  dispatch: (action: BrowserAction) => void;
  /** The computer's bookmarks bar's name on the phone. */
  barTitle: () => string;
  historyLimit: number;
  /** Saves the doc; it runs before each write, so a crash never reuses a batch's number. */
  save: (doc: SyncDoc) => Promise<void>;
  now?: () => number;
}

/** What a cycle found: whether the computer's profile has come, so the phone's tabs, bookmarks and history sync. */
export type CycleResult = { profile: boolean };

function appAdapters(doc: SyncDoc, deps: CycleDeps, retired: boolean): Adapter[] {
  return [retired ? retiredAdapter("dev:", `dev:${doc.deviceId}`) : deviceAdapter(doc.deviceId, deps.deviceName)];
}

function profileAdapters(doc: SyncDoc, deps: CycleDeps, retired: boolean): Adapter[] {
  if (retired) return [retiredAdapter("tabs:", `tabs:${doc.deviceId}`)];

  const adapters: Adapter[] = [];
  const data = deps.data;

  if (doc.types.tabs) adapters.push(deviceTabsAdapter(doc.deviceId, deps.deviceName, () => data().tabs));
  else adapters.push(retiredAdapter("tabs:", `tabs:${doc.deviceId}`));

  if (doc.types.bookmarks) {
    adapters.push(
      bookmarksAdapter({
        ready: deps.ready,
        bookmarks: () => data().bookmarks,
        replace: (bookmarks) => deps.dispatch({ type: "replace-bookmarks", bookmarks }),
        barTitle: deps.barTitle,
      }),
    );
  }

  if (doc.types.history) {
    adapters.push(
      historyAdapter({
        ready: deps.ready,
        history: () => data().history,
        limit: deps.historyLimit,
        apply: (change) => deps.dispatch({ type: "sync-history", ...change }),
        now: deps.now,
      }),
    );
  }

  return adapters;
}

/** A device's own record taken out: what a device leaving the chain, or no longer listing its tabs, publishes. */
function retiredAdapter(prefix: string, key: string): Adapter {
  return { prefix, extract: () => ({ values: new Map(), ignore: (other) => other !== key }), apply: () => true };
}

/** One cycle: the app's scope, then the profile's. `retired` takes this phone out of the chain's records. */
export async function runCycle(doc: SyncDoc, deps: CycleDeps, retired = false): Promise<CycleResult> {
  const now = deps.now ?? Date.now;
  const clock = new Clock(doc.deviceId, doc.clock, now);
  // A scope the phone hasn't read yet waits for what's there before it publishes, so joining merges into the chain.
  const app = (doc.scopes[APP_SCOPE] ??= { ...emptyScope(), awaitRemote: true });

  const persist = async () => {
    doc.clock = clock.last;
    await deps.save(doc);
  };

  await syncScope({
    scope: APP_SCOPE,
    state: app,
    transport: deps.transport,
    adapters: appAdapters(doc, deps, retired),
    clock,
    device: doc.deviceId,
    now,
    options: { persist },
  });

  doc.profile ??= defaultProfile(app);

  if (doc.profile) {
    const scope = `p:${doc.profile}`;
    const state = (doc.scopes[scope] ??= { ...emptyScope(), awaitRemote: true });

    await syncScope({
      scope,
      state,
      transport: deps.transport,
      adapters: profileAdapters(doc, deps, retired),
      clock,
      device: doc.deviceId,
      now,
      options: { expired: historyExpired, persist },
    });
  }

  doc.clock = clock.last;
  doc.lastSyncedAt = now();
  await deps.save(doc);

  return { profile: doc.profile !== null };
}

/** The computer's default profile's sync id, from its record in the app's scope. */
function defaultProfile(app: ScopeState): string | null {
  for (const [key, value] of visible(app, "prof:")) {
    const parsed = v.safeParse(ProfileSchema, value);

    if (parsed.success && parsed.output.d) return key.slice(5);
  }

  return null;
}

/** A device of the chain, as Settings › Sync lists it. */
export interface SyncedDevice {
  id: string;
  name: string;
  /** When it last wrote to the chain, as this phone has seen. */
  lastSeen: number | null;
  current: boolean;
}

export function syncedDevices(doc: SyncDoc): SyncedDevice[] {
  const app = doc.scopes[APP_SCOPE];

  if (!app) return [];

  const seen = { ...app.seen, ...(doc.profile ? doc.scopes[`p:${doc.profile}`]?.seen : undefined) };
  const devices: SyncedDevice[] = [];

  for (const [key, value] of visible(app, "dev:")) {
    const record = v.safeParse(DeviceRecordSchema, value);
    const id = key.slice(4);

    if (record.success) devices.push({ id, name: record.output.n, lastSeen: seen[id] ?? null, current: id === doc.deviceId });
  }

  return devices.sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/** Another device's open tabs, to open here. */
export type RemoteTabs = { deviceId: string; name: string; tabs: DeviceTabs["tabs"] };

export function remoteTabs(doc: SyncDoc): RemoteTabs[] {
  const profile = doc.profile ? doc.scopes[`p:${doc.profile}`] : undefined;

  if (!profile) return [];

  const devices: RemoteTabs[] = [];

  for (const [key, value] of visible(profile, "tabs:")) {
    const record = v.safeParse(DeviceTabsSchema, value);
    const deviceId = key.slice(5);

    if (record.success && deviceId !== doc.deviceId && record.output.tabs.length) devices.push({ deviceId, name: record.output.n, tabs: record.output.tabs });
  }

  return devices;
}
