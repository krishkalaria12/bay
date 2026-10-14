import { ownsProfileData } from "../store/spaces";
import { readDocument, saveDocument, writeDocument } from "@bay/shell";
import {
  Clock,
  emptyScope,
  folderTransport,
  restoreJournal,
  syncScope,
  SyncNative,
  visible,
  writtenSeq,
  type Adapter,
  type FolderInfo,
  type LogFile,
  type PhraseResult,
  type ScopeState,
} from "@bay/sync";
import { create } from "zustand";
import { useBrowser } from "../store/browser";
import { isIncognitoSpace } from "../store/model";
import { DEFAULT_SPACE_ID } from "../store/constants";
import type { Space } from "../store/types";
import {
  bookmarksAdapter,
  deviceAdapter,
  deviceTabsAdapter,
  historyAdapter,
  historyExpired,
  passwordsAdapter,
  pinnedAdapter,
  profilesAdapter,
  settingsAdapter,
  type DeviceRecord,
  type DeviceTabs,
  type ProfileRecord,
} from "./adapters";
import { APP_SCOPE, SYNC_AFTER_EDIT_MS, SYNC_CYCLE_MS, SYNC_DOC, SYNC_JOURNAL_FILE, SYNC_STATE_FILE } from "./constants";

export type DataType = "bookmarks" | "history" | "tabs" | "pinned" | "passwords" | "settings";

export const DATA_TYPES: { id: DataType; title: string; description: string }[] = [
  { id: "bookmarks", title: "Bookmarks", description: "Each synced profile’s bookmarks bar and other bookmarks." },
  { id: "history", title: "History", description: "The last 90 days." },
  { id: "tabs", title: "Open Tabs", description: "Your other devices’ tabs show in the tab overflow menu." },
  { id: "pinned", title: "Pinned Tabs and Groups", description: "Pinned tabs and pinned tab groups." },
  { id: "passwords", title: "Passwords", description: "Saved passwords. Turning sync off never removes them from this Mac." },
  { id: "settings", title: "Settings", description: "Search engine, appearance, tab and keyboard settings." },
];

type ProfileLink = {
  syncId: string;
  enabled: boolean;
  retire?: boolean;
};

type SyncDoc = {
  v: 1;
  enabled: boolean;
  folder: string | null;
  deviceId: string | null;
  clock: string | null;
  types: Record<DataType, boolean>;
  profiles: Record<string, ProfileLink>;
  scopes: Record<string, ScopeState>;
  lastSyncedAt: number | null;
  setupAt: number | null;
  joining: boolean;
  seqs?: Record<string, number>;
};

const defaultTypes = (): Record<DataType, boolean> => ({ bookmarks: true, history: true, tabs: true, pinned: true, passwords: true, settings: true });

const emptyDoc = (): SyncDoc => ({
  v: 1,
  enabled: false,
  folder: null,
  deviceId: null,
  clock: null,
  types: defaultTypes(),
  profiles: {},
  scopes: {},
  lastSyncedAt: null,
  setupAt: null,
  joining: false,
});

export type SyncStatus = "off" | "starting" | "updating" | "updated" | "stalled" | "offline" | "locked" | "reset" | "unavailable";

export type SyncedDevice = { id: string; name: string; lastSeen: number | null; current: boolean };
export type RemoteTabs = { deviceId: string; name: string; tabs: { url: string; title: string }[] };
export type RemoteProfile = { syncId: string; name: string; color: Space["color"]; icon: string | null };

type SyncUi = {
  status: SyncStatus;
  enabled: boolean;
  folder: string | null;
  types: Record<DataType, boolean>;
  profiles: Record<string, ProfileLink>;
  lastSyncedAt: number | null;
  error: string | null;
  pending: number;
  devices: SyncedDevice[];
  remoteTabs: Record<string, RemoteTabs[]>;
  remoteProfiles: RemoteProfile[];
};

export const useSync = create<SyncUi>(() => ({
  status: SyncNative ? "off" : "unavailable",
  enabled: false,
  folder: null,
  types: defaultTypes(),
  profiles: {},
  lastSyncedAt: null,
  error: null,
  pending: 0,
  devices: [],
  remoteTabs: {},
  remoteProfiles: [],
}));

let doc: SyncDoc = emptyDoc();
let savedJson = "";
let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let forcePasswords = false;
const passwordAdapters = new Map<string, Adapter>();

function load() {
  try {
    const json = readDocument(SYNC_DOC);
    if (json) doc = { ...emptyDoc(), ...(JSON.parse(json) as SyncDoc), scopes: {} };
    savedJson = json ?? "";
  } catch (error) {
    console.warn("[sync] couldn't read sync.json", error);
  }
}

// Batches numbered since the sealed state was last saved, kept until a saved state has them: a batch is
// in here, on disk, before it's written to the folder (`persist`), so a crash can't reuse its seq.
type Journal = Record<string, LogFile[]>;
let journal: Journal = {};
let journalOnDisk = false;

async function openSealed<T>(name: string, fallback: T): Promise<T> {
  const sealed = readDocument(name);
  const json = sealed ? await SyncNative?.openLocal(sealed) : null;
  try {
    if (json) return JSON.parse(json) as T;
  } catch {}
  return fallback;
}

async function loadState() {
  const scopes = await openSealed<SyncDoc["scopes"]>(SYNC_STATE_FILE, {});
  journal = (await openSealed<{ journal?: Journal }>(SYNC_JOURNAL_FILE, {})).journal ?? {};
  journalOnDisk = Object.keys(journal).length > 0;
  const clock = new Clock(doc.deviceId ?? "", doc.clock);
  for (const scope of new Set([...Object.keys(doc.seqs ?? {}), ...Object.keys(journal)])) {
    const mine = (journal[scope] ?? []).filter((f) => f.device === doc.deviceId);
    restoreJournal((scopes[scope] ??= emptyScope()), mine, clock, doc.seqs?.[scope]);
  }
  if (doc.deviceId && Object.keys(journal).length) doc.clock = clock.last;
  doc.scopes = scopes;
}

const persistJournal = (scope: string) => async (batches: LogFile[]) => {
  const list = (journal[scope] ??= []);
  for (const file of batches) if (!list.some((f) => f.seq === file.seq)) list.push(file);
  const sealed = await SyncNative!.sealLocal(JSON.stringify({ journal }));
  // The journal must be on disk before the batches are published: after a crash, it's how this device knows
  // which sequence numbers it already used.
  await saveDocument(SYNC_JOURNAL_FILE, sealed);
  journalOnDisk = true;
};

function pruneJournal(saved: Record<string, number>) {
  for (const [scope, list] of Object.entries(journal)) {
    const left = list.filter((f) => f.seq > (saved[scope] ?? 0));
    if (left.length) journal[scope] = left;
    else delete journal[scope];
  }
  if (journalOnDisk && !Object.keys(journal).length) clearJournal();
}

function clearJournal() {
  journal = {};
  journalOnDisk = false;
  writeDocument(SYNC_JOURNAL_FILE, "");
}

let savedState = "";
let sealing: Promise<void> | null = null;

function save() {
  const { scopes, ...meta } = doc;
  const json = JSON.stringify({ ...meta, seqs: Object.fromEntries(Object.entries(scopes).map(([k, s]) => [k, writtenSeq(s)])) });
  if (json !== savedJson) {
    savedJson = json;
    writeDocument(SYNC_DOC, json);
  }
  const state = doc.enabled ? JSON.stringify(scopes) : "";
  if (state === savedState || sealing) return;
  if (!state) {
    savedState = "";
    writeDocument(SYNC_STATE_FILE, "");
    return;
  }
  const seqs = Object.fromEntries(Object.entries(scopes).map(([k, s]) => [k, s.seq]));
  sealing = (async () => {
    try {
      const sealed = await SyncNative?.sealLocal(state);
      if (sealed) {
        // Only once the state is on disk may the journal entries it covers go.
        await saveDocument(SYNC_STATE_FILE, sealed);
        savedState = state;
        pruneJournal(seqs);
      }
    } catch (error) {
      console.warn("[sync] couldn't save the sync state", error);
    } finally {
      sealing = null;
    }
    if (doc.enabled && JSON.stringify(doc.scopes) !== savedState) save();
  })();
}

function publishUi(patch: Partial<SyncUi> = {}) {
  useSync.setState({
    enabled: doc.enabled,
    folder: doc.folder,
    types: { ...doc.types },
    profiles: { ...doc.profiles },
    lastSyncedAt: doc.lastSyncedAt,
    ...(doc.enabled ? summarize() : { devices: [], remoteTabs: {}, remoteProfiles: [], pending: 0 }),
    ...patch,
  });
}

export const deviceName = () => SyncNative?.deviceName() ?? "This Mac";

// MARK: Adapters

function appAdapters(retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceAdapter(id, deviceName, true)];
  return [
    ...(doc.types.settings ? [settingsAdapter] : []),
    profilesAdapter(() => Object.fromEntries(Object.entries(doc.profiles).filter(([, l]) => l.enabled))),
    deviceAdapter(id, deviceName),
  ];
}

function profileAdapters(spaceId: string, retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceTabsAdapter(spaceId, id, deviceName, true)];
  const t = doc.types;
  let passwords = passwordAdapters.get(spaceId);
  if (!passwords) passwordAdapters.set(spaceId, (passwords = passwordsAdapter(spaceId, () => forcePasswords)));
  // Spaces sharing sign-ins share one profile's bookmarks, history and passwords: one of them syncs those.
  const owns = ownsProfileData(useBrowser.getState(), spaceId);
  return [
    ...(t.pinned ? [pinnedAdapter(spaceId)] : []),
    ...(t.bookmarks && owns ? [bookmarksAdapter(spaceId)] : []),
    ...(t.history && owns ? [historyAdapter(spaceId)] : []),
    deviceTabsAdapter(spaceId, id, deviceName, !t.tabs),
    ...(t.passwords && owns ? [passwords] : []),
  ];
}

// MARK: The cycle

export function scheduleSync(delay = SYNC_AFTER_EDIT_MS) {
  if (!doc.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}

export async function syncNow() {
  forcePasswords = true;
  await runCycle();
}

async function runCycle({ retiring = false } = {}) {
  const native = SyncNative;
  if (!native || !doc.enabled || !doc.folder || !doc.deviceId) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(timer);
  const slow = setTimeout(() => useSync.getState().status === "updated" && publishUi({ status: "updating" }), 1000);
  try {
    const status = await native.chainStatus(doc.folder);
    if (status === "unavailable") return publishUi({ status: "offline", error: null });
    if (status === "missing") return await resetFromElsewhere();
    const transport = folderTransport(native, doc.folder);
    const clock = new Clock(doc.deviceId, doc.clock);
    const device = doc.deviceId;
    const app = (doc.scopes[APP_SCOPE] ??= { ...emptyScope(), awaitRemote: doc.joining });
    await syncScope({
      scope: APP_SCOPE,
      state: app,
      transport,
      adapters: appAdapters(retiring),
      clock,
      device,
      options: { persist: persistJournal(APP_SCOPE) },
    });
    if (app.joined) linkProfiles(app);
    let pending = app.pending;
    const s = useBrowser.getState();
    for (const [spaceId, link] of Object.entries(doc.profiles)) {
      const exists = !!s.spaces[spaceId];
      const retire = retiring || !!link.retire || !exists;
      if (!retire && !link.enabled) continue;
      const scope = `p:${link.syncId}`;
      const state = (doc.scopes[scope] ??= emptyScope());
      await syncScope({
        scope,
        state,
        transport,
        adapters: profileAdapters(spaceId, retire),
        clock,
        device,
        options: { expired: historyExpired, persist: persistJournal(scope) },
      });
      pending += state.pending;
      if (retire) {
        delete link.retire;
        if (!exists) {
          delete doc.scopes[scope];
          delete doc.profiles[spaceId];
        }
      }
    }
    doc.clock = clock.last;
    doc.lastSyncedAt = Date.now();
    if (app.joined) doc.joining = false;
    forcePasswords = false;
    publishUi({ status: "updated", error: null, pending });
  } catch (error) {
    console.warn("[sync] cycle failed", error);
    publishUi({ status: "stalled", error: errorText(error) });
  } finally {
    clearTimeout(slow);
    running = false;
    save();
    if (doc.enabled) {
      if (again) {
        again = false;
        scheduleSync(0);
      } else {
        scheduleSync(SYNC_CYCLE_MS);
      }
    }
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function linkProfiles(app: ScopeState) {
  const s = useBrowser.getState();
  const remote = [...visible(app, "prof:")].map(([k, v]) => [k.slice(5), v as ProfileRecord] as const);
  const taken = new Set(Object.values(doc.profiles).map((l) => l.syncId));
  for (const id of s.spaceOrder) {
    const profile = s.spaces[id];
    if (!profile || isIncognitoSpace(id) || doc.profiles[id]) continue;
    const match = doc.joining ? remote.find(([syncId, r]) => !taken.has(syncId) && (id === DEFAULT_SPACE_ID ? r.d : r.n === profile.name))?.[0] : undefined;
    const syncId = match ?? SyncNative!.newDeviceId();
    doc.profiles[id] = { syncId, enabled: true };
    taken.add(syncId);
    // Read the existing chain before publishing local sync data.
    if (match) doc.scopes[`p:${syncId}`] = { ...emptyScope(), awaitRemote: true };
  }
  for (const [id, link] of Object.entries(doc.profiles)) if (!s.spaces[id] && !link.retire) link.retire = true;
}

async function resetFromElsewhere() {
  await SyncNative?.forget(doc.deviceId!);
  doc = { ...emptyDoc(), folder: doc.folder, types: doc.types };
  clearJournal();
  save();
  publishUi({ status: "reset", error: "This device is out of sync. Sync may have been reset from another device." });
}

function summarize(): Pick<SyncUi, "devices" | "remoteTabs" | "remoteProfiles"> {
  const app = doc.scopes[APP_SCOPE];
  if (!app) return { devices: [], remoteTabs: {}, remoteProfiles: [] };
  const lastSeen = new Map<string, number>();
  for (const scope of Object.values(doc.scopes)) {
    for (const [device, at] of Object.entries(scope.seen)) lastSeen.set(device, Math.max(at, lastSeen.get(device) ?? 0));
  }
  const names = new Map([...visible(app, "dev:")].map(([k, v]) => [k.slice(4), (v as DeviceRecord).n]));
  const devices: SyncedDevice[] = [...names].map(([id, name]) => ({ id, name, lastSeen: lastSeen.get(id) ?? null, current: id === doc.deviceId }));
  devices.sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const remoteTabs: Record<string, RemoteTabs[]> = {};
  for (const [spaceId, link] of Object.entries(doc.profiles)) {
    const scope = doc.scopes[`p:${link.syncId}`];
    if (!scope || !link.enabled) continue;
    remoteTabs[spaceId] = [...visible(scope, "tabs:")]
      .map(([k, v]) => ({ deviceId: k.slice(5), value: v as DeviceTabs }))
      // A device that stopped syncing took its record away; one without a name record is on its way out.
      .filter(({ deviceId, value }) => deviceId !== doc.deviceId && names.has(deviceId) && value.tabs.length > 0)
      .map(({ deviceId, value }) => ({
        deviceId,
        name: names.get(deviceId) || value.n || "Unknown Device",
        tabs: value.tabs.map((t) => ({ url: t.u, title: t.t })),
      }));
  }
  const linked = new Set(Object.values(doc.profiles).map((l) => l.syncId));
  const remoteProfiles = [...visible(app, "prof:")]
    .filter(([k]) => !linked.has(k.slice(5)))
    .map(([k, v]) => ({ syncId: k.slice(5), name: (v as ProfileRecord).n, color: (v as ProfileRecord).c, icon: (v as ProfileRecord).i }));
  return { devices, remoteTabs, remoteProfiles };
}

// MARK: Setup

export async function folderInfo(path?: string | null): Promise<FolderInfo | null> {
  return (await SyncNative?.folderInfo(path ?? doc.folder ?? null)) ?? null;
}

export function setSyncFolder(path: string) {
  if (doc.enabled) return;
  doc.folder = path;
  save();
  publishUi();
}

export async function chooseSyncFolder(): Promise<string | null> {
  const picked = (await SyncNative?.chooseFolder(doc.folder)) ?? null;
  if (picked) setSyncFolder(picked);
  return picked;
}

function begin(folder: string, deviceId: string, joining: boolean) {
  doc = { ...emptyDoc(), types: doc.types, enabled: true, folder, deviceId, setupAt: Date.now(), joining };
  clearJournal();
  save();
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}

export async function turnOnSync(folder: string): Promise<{ ok: true } | { error: string }> {
  const native = SyncNative;
  if (!native) return { error: "Sync isn’t available in this build." };
  const deviceId = native.newDeviceId();
  try {
    if (!(await native.createPhrase(deviceId))) return { error: "Couldn’t save the sync key in your Keychain." };
    await native.createChain(folder);
  } catch (error) {
    await native.forget(deviceId);
    return { error: `Couldn’t use that folder: ${errorText(error)}` };
  }
  begin(folder, deviceId, false);
  return { ok: true };
}

export async function enterRecoveryPhrase(folder: string, text: string): Promise<PhraseResult | { error: "unavailable" }> {
  const native = SyncNative;
  if (!native) return { error: "unavailable" };
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, text, doc.folder ?? folder);
    if ("ok" in result) {
      await loadState();
      publishUi({ status: "starting", error: null });
      scheduleSync(0);
    }
    return result;
  }
  const deviceId = native.newDeviceId();
  const result = await native.enterPhrase(deviceId, text, folder);
  if ("ok" in result) begin(folder, deviceId, true);
  return result;
}

export async function stopSync({ deleteData = false } = {}) {
  const native = SyncNative;
  if (!native || !doc.enabled) return;
  clearTimeout(timer);
  while (running) await new Promise((r) => setTimeout(r, 100));
  try {
    if (useSync.getState().status !== "locked") await runCycle({ retiring: true });
  } catch {}
  clearTimeout(timer);
  const folder = doc.folder;
  if (deleteData && folder) {
    try {
      await native.deleteChain(folder);
    } catch (error) {
      console.warn("[sync] deleting sync data failed", error);
    }
  }
  if (doc.deviceId) await native.forget(doc.deviceId);
  doc = { ...emptyDoc(), folder, types: doc.types };
  passwordAdapters.clear();
  clearJournal();
  save();
  publishUi({ status: "off", error: null });
}

export function setTypeSynced(type: DataType, enabled: boolean) {
  doc.types = { ...doc.types, [type]: enabled };
  save();
  publishUi();
  scheduleSync(0);
}

export function setProfileSynced(spaceId: string, enabled: boolean) {
  const link = doc.profiles[spaceId];
  if (!link) return;
  doc.profiles[spaceId] = enabled ? { syncId: link.syncId, enabled } : { ...link, enabled, retire: true };
  save();
  publishUi();
  scheduleSync(0);
}

export function addRemoteProfile(syncId: string): string | null {
  const record = doc.scopes[APP_SCOPE]?.records[`prof:${syncId}`]?.v as ProfileRecord | undefined;
  if (!record) return null;
  const id = useBrowser.getState().createSpace({ name: record.n, color: record.c, icon: record.i });
  if (typeof record.f === "boolean") useBrowser.getState().updateSpace(id, { folded: record.f });
  doc.profiles[id] = { syncId, enabled: true };
  doc.scopes[`p:${syncId}`] = { ...emptyScope(), awaitRemote: true };
  save();
  publishUi();
  scheduleSync(0);
  return id;
}

// MARK: Launch

export function startSync() {
  if (!SyncNative) return;
  load();
  publishUi({ status: doc.enabled ? "starting" : "off" });
  if (doc.enabled && doc.deviceId) {
    void SyncNative.unlock(doc.deviceId).then(async (ok) => {
      if (!ok) return publishUi({ status: "locked", error: "Enter your recovery phrase to keep syncing on this Mac." });
      await loadState();
      publishUi();
      scheduleSync(500);
    });
  }
  useBrowser.subscribe((s, prev) => {
    if (!doc.enabled || running) return;
    if (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.spaces !== prev.spaces || s.groups !== prev.groups) scheduleSync();
  });
  if (__DEV__) {
    (globalThis as { nnSync?: object }).nnSync = {
      useSync,
      syncNow,
      turnOnSync,
      enterRecoveryPhrase,
      stopSync,
      setTypeSynced,
      setProfileSynced,
      addRemoteProfile,
      setSyncFolder,
      folderInfo,
      doc: () => doc,
      native: SyncNative,
      get menu(): typeof import("./menu") {
        return require("./menu");
      },
      get sheets(): typeof import("../components/settings/panes/SyncSheets") {
        return require("../components/settings/panes/SyncSheets");
      },
    };
  }
}
