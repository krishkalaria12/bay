// The phone's sync cycle, as the computer's (apps/browser/src/sync/engine.ts) runs its own over the same chain: the
// app's scope first, where every device names itself and the computer lists its profiles, then the scope of the
// computer's default profile, where the open tabs, bookmarks and history are. Pure: the store, the relay and the
// saving come in as functions, so the tests sync a phone with a stand-in computer.
import type { JsonValue } from "@bay/sync/src/canon.ts";
import { Clock } from "@bay/sync/src/hlc.ts";
import { emptyScope, syncScope, visible, type Adapter, type ScopeState, type Transport } from "@bay/sync/src/scope.ts";
import * as v from "valibot";

import { PERSONAL_SPACE_ID, spaceBookmarks, spaceHistory, type BrowserAction } from "../store/model.ts";
import type { BrowserData, BrowserSpace } from "../store/types.ts";
import {
  bookmarksAdapter,
  deviceAdapter,
  DeviceRecordSchema,
  deviceTabsAdapter,
  DeviceTabsSchema,
  HISTORY_WINDOW_MS,
  historyAdapter,
  phoneColor,
  pinsAdapter,
  profilesAdapter,
  remoteProfiles,
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
  /**
   * Each of the phone's spaces and the computer's space it is (space id → the profile's sync id), as the computer
   * links its own: the first space is the computer's default one, the computer's others come here as spaces, and a
   * space made here gets a profile of its own.
   */
  spaces?: Record<string, string>;
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
  /** A new profile's sync id, for a space made on the phone. */
  newSyncId: () => string;
  now?: () => number;
}

/** What a cycle found: whether the computer's profile has come, so the phone's tabs, bookmarks and history sync. */
export type CycleResult = { profile: boolean };

function appAdapters(doc: SyncDoc, deps: CycleDeps, retired: boolean): Adapter[] {
  if (retired) return [retiredAdapter("dev:", `dev:${doc.deviceId}`)];

  return [
    deviceAdapter(doc.deviceId, deps.deviceName),
    profilesAdapter({
      links: () => doc.spaces ?? {},
      spaces: () => deps.data().spaces,
      change: (changed) => deps.dispatch({ type: "sync-spaces", added: [], changed }),
    }),
  ];
}

/** A space's scope: its open tabs and pins; the default profile's also has the bookmarks and history. */
function spaceAdapters(doc: SyncDoc, deps: CycleDeps, spaceId: string, main: boolean, retired: boolean): Adapter[] {
  if (retired) return [retiredAdapter("tabs:", `tabs:${doc.deviceId}`)];

  const adapters: Adapter[] = [];
  const data = deps.data;

  if (doc.types.tabs) {
    adapters.push(
      deviceTabsAdapter(doc.deviceId, deps.deviceName, () => data().tabs.filter((tab) => tab.spaceId === spaceId)),
      pinsAdapter({
        ready: deps.ready,
        pins: () => data().pinnedSites.filter((site) => site.spaceId === spaceId),
        folders: () => data().folders.filter((folder) => folder.spaceId === spaceId),
        replace: (pins, folders) => deps.dispatch({ type: "sync-space-pins", spaceId, pins, folders }),
      }),
    );
  } else adapters.push(retiredAdapter("tabs:", `tabs:${doc.deviceId}`));

  if (!main) return adapters;

  if (doc.types.bookmarks) {
    adapters.push(
      bookmarksAdapter({
        ready: deps.ready,
        // The computer's default profile is the phone's personal space: its bookmarks and history are the ones that sync.
        bookmarks: () => spaceBookmarks(data(), PERSONAL_SPACE_ID),
        replace: (bookmarks) => deps.dispatch({ type: "replace-bookmarks", bookmarks }),
        barTitle: deps.barTitle,
      }),
    );
  }

  if (doc.types.history) {
    adapters.push(
      historyAdapter({
        ready: deps.ready,
        history: () => spaceHistory(data(), PERSONAL_SPACE_ID),
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

  if (doc.profile && !retired) linkSpaces(doc, deps, app);

  for (const [spaceId, syncId] of spaceScopes(doc, deps)) {
    const scope = `p:${syncId}`;
    const state = (doc.scopes[scope] ??= { ...emptyScope(), awaitRemote: true });

    await syncScope({
      scope,
      state,
      transport: deps.transport,
      adapters: spaceAdapters(doc, deps, spaceId, syncId === doc.profile, retired),
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

/**
 * Links the phone's spaces to the computer's: the first to its default space, its others by name or as new spaces
 * here, and each space made here to a profile of its own, which the computer then offers to add.
 */
function linkSpaces(doc: SyncDoc, deps: CycleDeps, app: ScopeState): void {
  if (!deps.ready()) return;

  const links = (doc.spaces ??= {});
  const spaces = deps.data().spaces;

  for (const id of Object.keys(links)) if (!spaces.some((space) => space.id === id)) delete links[id];

  const linked = new Set(Object.values(links));

  if (doc.profile && !linked.has(doc.profile) && spaces[0] && !links[spaces[0].id]) {
    links[spaces[0].id] = doc.profile;
    linked.add(doc.profile);
  }

  const added: BrowserSpace[] = [];

  for (const [syncId, record] of remoteProfiles(visible(app, "prof:"))) {
    if (linked.has(syncId)) continue;

    const named = spaces.find((space) => !links[space.id] && space.name === record.n);
    const id = named?.id ?? `sync-${syncId}`;

    if (!named) added.push({ id, name: record.n, color: phoneColor(record.c), icon: record.i });
    links[id] = syncId;
    linked.add(syncId);
  }

  if (added.length) deps.dispatch({ type: "sync-spaces", added, changed: [] });

  for (const space of deps.data().spaces) if (!links[space.id]) links[space.id] = deps.newSyncId();
}

/** The scopes a cycle syncs: each linked space's, and the default profile's before any space is linked to it. */
function spaceScopes(doc: SyncDoc, deps: CycleDeps): [string, string][] {
  const pairs = Object.entries(doc.spaces ?? {});

  if (doc.profile && !pairs.some(([, syncId]) => syncId === doc.profile)) pairs.unshift([deps.data().spaces[0]?.id ?? "", doc.profile]);

  return pairs;
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
