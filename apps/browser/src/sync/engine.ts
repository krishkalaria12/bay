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
import { isIncognitoProfile } from "../store/model";
import { DEFAULT_PROFILE_ID } from "../store/settings";
import type { Profile } from "../store/types";
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

const DOC = "sync.json";
const STATE = "sync-state.nns";
const JOURNAL = "sync-journal.nns";
const APP_SCOPE = "app";
const CYCLE_MS = 15_000;
const AFTER_EDIT_MS = 3_000;

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
export type RemoteProfile = { syncId: string; name: string; color: Profile["color"]; icon: string | null };

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
let started = false;
let startup: Promise<void> = Promise.resolve();
type CycleOutcome = { error?: unknown };
let activeCycle: Promise<CycleOutcome> | null = null;
let stateLoaded = true;
let metadataLoadError: Error | null = null;
let quitPaused = false;
let saveGeneration = 0;
const mutations = new Set<Promise<unknown>>();

function trackMutation<T>(run: () => Promise<T>): Promise<T> {
  const task = run();
  mutations.add(task);
  void task.finally(() => mutations.delete(task)).catch(() => {});
  return task;
}

function load() {
  try {
    const json = readDocument(DOC);
    if (json !== null) {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.enabled !== "boolean") throw new Error("Invalid sync metadata");
      const restored = { ...emptyDoc(), ...parsed, scopes: {} } as SyncDoc;
      if (!isRecord(restored.types) || DATA_TYPES.some(({ id }) => typeof restored.types[id] !== "boolean")
        || !isRecord(restored.profiles) || Object.values(restored.profiles).some((link) => !isRecord(link) || typeof link.syncId !== "string" || typeof link.enabled !== "boolean")
        || (restored.folder !== null && typeof restored.folder !== "string") || (restored.deviceId !== null && typeof restored.deviceId !== "string")
        || (restored.clock !== null && typeof restored.clock !== "string") || typeof restored.joining !== "boolean"
        || (restored.enabled && (!restored.folder || !restored.deviceId))
        || (restored.seqs !== undefined && (!isRecord(restored.seqs) || Object.values(restored.seqs).some((seq) => !Number.isSafeInteger(seq) || seq < 0)))) {
        throw new Error("Invalid sync metadata");
      }
      doc = restored;
    }
    metadataLoadError = null;
    savedJson = json ?? "";
  } catch (error) {
    metadataLoadError = new Error("Couldn't read the saved sync metadata. Existing sync files have been preserved.", { cause: error });
    console.warn("[sync] couldn't read sync.json", error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Batches numbered since the sealed state was last saved, kept until a saved state has them: a batch is
// in here, on disk, before it's written to the folder (`persist`), so a crash can't reuse its seq.
type Journal = Record<string, LogFile[]>;
let journal: Journal = {};
let journalOnDisk = false;

async function openSealed<T>(name: string, fallback: T): Promise<T> {
  const sealed = readDocument(name);
  if (!sealed) return fallback;
  const json = await SyncNative?.openLocal(sealed);
  if (!json) throw new Error(`Couldn't open ${name}. Existing sync files have been preserved.`);
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error(`Invalid saved sync data in ${name}`);
  return parsed as T;
}

async function loadState() {
  const owner = doc;
  const scopes = await openSealed<SyncDoc["scopes"]>(STATE, {});
  const journalDoc = await openSealed<{ journal?: Journal }>(JOURNAL, {});
  if (Object.values(scopes).some((scope) => !isRecord(scope) || !isRecord(scope.records) || !isRecord(scope.base)
    || !isRecord(scope.seen) || !isRecord(scope.vv) || !isRecord(scope.extra) || !isRecord(scope.files) || !isRecord(scope.damaged)
    || !Array.isArray(scope.unapplied) || !Array.isArray(scope.outbox) || (scope.journal !== undefined && !Array.isArray(scope.journal))
    || !Number.isSafeInteger(scope.seq) || scope.seq < 0)
    || (journalDoc.journal !== undefined && (!isRecord(journalDoc.journal) || Object.values(journalDoc.journal).some((files) => !Array.isArray(files))))) {
    throw new Error("Invalid saved sync data. Existing sync files have been preserved.");
  }
  const loadedJournal = journalDoc.journal ?? {};
  if (doc !== owner) return false;
  journal = loadedJournal;
  journalOnDisk = Object.keys(journal).length > 0;
  const clock = new Clock(doc.deviceId ?? "", doc.clock);
  for (const scope of new Set([...Object.keys(doc.seqs ?? {}), ...Object.keys(journal)])) {
    const mine = (journal[scope] ?? []).filter((f) => f.device === doc.deviceId);
    restoreJournal((scopes[scope] ??= emptyScope()), mine, clock, doc.seqs?.[scope]);
  }
  if (doc.deviceId && Object.keys(journal).length) doc.clock = clock.last;
  doc.scopes = scopes;
  stateLoaded = true;
  return true;
}

const persistJournal = (scope: string) => async (batches: LogFile[]) => {
  const list = (journal[scope] ??= []);
  for (const file of batches) if (!list.some((f) => f.seq === file.seq)) list.push(file);
  const sealed = await SyncNative!.sealLocal(JSON.stringify({ journal }));
  // The journal must be on disk before the batches are published: after a crash, it's how this device knows
  // which sequence numbers it already used.
  await saveDocument(JOURNAL, sealed);
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
  if (!quitPaused && !metadataLoadError) writeDocument(JOURNAL, "");
}

let savedState: string | null = null;
let sealing: Promise<void> | null = null;

function metadataJson() {
  const { scopes, ...meta } = doc;
  return JSON.stringify({ ...meta, seqs: stateLoaded ? Object.fromEntries(Object.entries(scopes).map(([k, s]) => [k, writtenSeq(s)])) : doc.seqs ?? {} });
}

function save() {
  if (quitPaused || metadataLoadError || !started || !SyncNative) return;
  const json = metadataJson();
  if (json !== savedJson) {
    savedJson = json;
    writeDocument(DOC, json);
  }
  // Until unlock/load finishes, the ciphertext on disk is the only copy of the
  // previous state. Never replace it with the temporary empty scopes map.
  if (!stateLoaded) return;
  const state = doc.enabled ? JSON.stringify(doc.scopes) : "";
  if (state === savedState) return;
  if (!state) {
    savedState = "";
    writeDocument(STATE, "");
    return;
  }
  if (sealing) return;
  const seqs = Object.fromEntries(Object.entries(doc.scopes).map(([k, s]) => [k, s.seq]));
  const generation = saveGeneration;
  sealing = (async () => {
    let saved = false;
    try {
      const sealed = await SyncNative?.sealLocal(state);
      if (!sealed) throw new Error("Couldn't encrypt the sync state");
      if (generation === saveGeneration && !quitPaused) {
        // Only once the state is on disk may the journal entries it covers go.
        await saveDocument(STATE, sealed);
        if (generation === saveGeneration && !quitPaused) {
          savedState = state;
          pruneJournal(seqs);
          saved = true;
        }
      }
    } catch (error) {
      console.warn("[sync] couldn't save the sync state", error);
    } finally {
      sealing = null;
    }
    // Coalesce edits made during a successful save. A failed seal/write waits
    // for a later cycle or explicit checkpoint instead of retrying forever.
    if (saved && !quitPaused && doc.enabled && JSON.stringify(doc.scopes) !== savedState) save();
  })();
}

// Leave time for the other quit owners and the native 20-second deadline.
const QUIT_DEADLINE_MS = 15_000;
type QuitAttempt = {
  valid: boolean;
  promise: Promise<void>;
  reject(error: Error): void;
  deadline?: ReturnType<typeof setTimeout>;
};
let quitAttempt: QuitAttempt | null = null;

function quitError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function currentAttempt(attempt: QuitAttempt) {
  if (!attempt.valid || quitAttempt !== attempt || !quitPaused) {
    throw quitError("sync_quit_cancelled", "Sync quit preparation was cancelled");
  }
}

async function checkpoint(attempt: QuitAttempt) {
  if (!SyncNative || !started) return;
  if (metadataLoadError) throw metadataLoadError;
  const initialCycle = activeCycle;
  await startup;
  currentAttempt(attempt);
  await Promise.all([...mutations]);
  currentAttempt(attempt);
  const cycle = activeCycle ?? initialCycle;
  if (cycle) {
    const outcome = await cycle;
    currentAttempt(attempt);
    if (doc.enabled && outcome.error) throw outcome.error;
  }
  if (sealing) await sealing;
  currentAttempt(attempt);

  const metadata = metadataJson();
  const state = doc.enabled && stateLoaded ? JSON.stringify(doc.scopes) : "";
  const remaining: Journal = doc.enabled && stateLoaded
    ? Object.fromEntries(Object.entries(journal).map(([scope, files]) => [scope, files.filter((file) => file.seq > (doc.scopes[scope]?.seq ?? 0))] as const).filter(([, files]) => files.length))
    : journal;
  // Locked sync has not opened these files. Acknowledging their existing bytes
  // preserves the previous state without requiring unlock or dropping keys.
  let sealedState = doc.enabled && !stateLoaded ? readDocument(STATE) ?? "" : "";
  let sealedJournal = doc.enabled && !stateLoaded ? readDocument(JOURNAL) ?? "" : "";
  if (state) {
    sealedState = await SyncNative.sealLocal(state);
    currentAttempt(attempt);
    if (!sealedState) throw new Error("Couldn't encrypt the sync state before quitting");
  }
  if (doc.enabled && stateLoaded && Object.keys(remaining).length) {
    sealedJournal = await SyncNative.sealLocal(JSON.stringify({ journal: remaining }));
    currentAttempt(attempt);
    if (!sealedJournal) throw new Error("Couldn't encrypt the sync journal before quitting");
  }
  currentAttempt(attempt);
  // State must be durable before its covered journal entries can be removed.
  await saveDocument(STATE, sealedState);
  currentAttempt(attempt);
  await saveDocument(JOURNAL, sealedJournal);
  currentAttempt(attempt);
  await saveDocument(DOC, metadata);
  currentAttempt(attempt);
  savedJson = metadata;
  if (stateLoaded) {
    savedState = state;
    journal = doc.enabled ? remaining : {};
    journalOnDisk = Object.keys(journal).length > 0;
  }
}

/** Reversible local durability barrier. It never starts another folder cycle. */
export function prepareSyncForQuit(): Promise<void> {
  if (quitAttempt) return quitAttempt.promise;
  quitPaused = true;
  saveGeneration++;
  clearTimeout(timer);
  timer = undefined;
  again = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  void promise.catch(() => {});
  const attempt: QuitAttempt = { valid: true, promise, reject };
  quitAttempt = attempt;
  attempt.deadline = setTimeout(() => {
    if (quitAttempt !== attempt || !attempt.valid) return;
    attempt.valid = false;
    reject(quitError("sync_quit_timeout", "Sync could not finish saving before the quit deadline"));
  }, QUIT_DEADLINE_MS);
  void checkpoint(attempt).then(() => {
    if (quitAttempt !== attempt || !attempt.valid) return;
    clearTimeout(attempt.deadline);
    resolve();
  }, (error: unknown) => {
    if (quitAttempt !== attempt || !attempt.valid) return;
    attempt.valid = false;
    clearTimeout(attempt.deadline);
    reject(error instanceof Error ? error : new Error(String(error)));
  });
  return promise;
}

export function resumeSyncAfterQuit() {
  // Invalidate first: an old seal/save completion must not enqueue another
  // write after resumed producers begin saving newer state.
  const previous = quitAttempt;
  quitAttempt = null;
  if (previous) {
    previous.valid = false;
    clearTimeout(previous.deadline);
    previous.reject(quitError("sync_quit_cancelled", "Sync quit preparation was cancelled"));
  }
  saveGeneration++;
  quitPaused = false;
  if (!started || !SyncNative) return;
  save();
  if (started && doc.enabled && stateLoaded) scheduleSync(0);
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

function profileAdapters(profileId: string, retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceTabsAdapter(profileId, id, deviceName, true)];
  const s = useBrowser.getState();
  const ownsData = !s.profiles[profileId]?.dataId;
  const t = doc.types;
  let passwords = passwordAdapters.get(profileId);
  if (!passwords) passwordAdapters.set(profileId, (passwords = passwordsAdapter(profileId, () => forcePasswords)));
  return [
    ...(t.pinned ? [pinnedAdapter(profileId)] : []),
    ...(t.bookmarks && ownsData ? [bookmarksAdapter(profileId)] : []),
    ...(t.history && ownsData ? [historyAdapter(profileId)] : []),
    deviceTabsAdapter(profileId, id, deviceName, !t.tabs),
    ...(t.passwords && ownsData ? [passwords] : []),
  ];
}

// MARK: The cycle

export function scheduleSync(delay = AFTER_EDIT_MS) {
  if (!doc.enabled || quitPaused) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}

export async function syncNow() {
  if (quitPaused) {
    if (activeCycle) await activeCycle;
    return;
  }
  forcePasswords = true;
  await startup;
  if (activeCycle) await activeCycle;
  else if (!quitPaused) await runCycle();
}

function runCycle({ retiring = false } = {}): Promise<CycleOutcome> {
  if (activeCycle) {
    again = true;
    return activeCycle;
  }
  if ((quitPaused && !retiring) || !stateLoaded) return Promise.resolve({});
  const task = executeCycle({ retiring });
  activeCycle = task;
  void task.finally(() => { if (activeCycle === task) activeCycle = null; }).catch(() => {});
  return task;
}

async function executeCycle({ retiring = false } = {}): Promise<CycleOutcome> {
  const native = SyncNative;
  if (!native || !doc.enabled || !doc.folder || !doc.deviceId) return {};
  running = true;
  clearTimeout(timer);
  const slow = setTimeout(() => useSync.getState().status === "updated" && publishUi({ status: "updating" }), 1000);
  let cycleClock: Clock | null = null;
  try {
    const status = await native.chainStatus(doc.folder);
    if (status === "unavailable") {
      publishUi({ status: "offline", error: null });
      return {};
    }
    if (status === "missing") {
      await resetFromElsewhere();
      return {};
    }
    const transport = folderTransport(native, doc.folder);
    const clock = new Clock(doc.deviceId, doc.clock);
    cycleClock = clock;
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
    for (const [profileId, link] of Object.entries(doc.profiles)) {
      const exists = !!s.profiles[profileId];
      const retire = retiring || !!link.retire || !exists;
      if (!retire && !link.enabled) continue;
      const scope = `p:${link.syncId}`;
      const state = (doc.scopes[scope] ??= emptyScope());
      await syncScope({
        scope,
        state,
        transport,
        adapters: profileAdapters(profileId, retire),
        clock,
        device,
        options: { expired: historyExpired, persist: persistJournal(scope) },
      });
      pending += state.pending;
      if (retire) {
        delete link.retire;
        if (!exists) {
          delete doc.scopes[scope];
          delete doc.profiles[profileId];
        }
      }
    }
    doc.clock = clock.last;
    doc.lastSyncedAt = Date.now();
    if (app.joined) doc.joining = false;
    forcePasswords = false;
    publishUi({ status: "updated", error: null, pending });
    return {};
  } catch (error) {
    console.warn("[sync] cycle failed", error);
    publishUi({ status: "stalled", error: errorText(error) });
    return { error };
  } finally {
    clearTimeout(slow);
    running = false;
    if (cycleClock) doc.clock = cycleClock.last;
    save();
    if (doc.enabled) {
      if (again) {
        again = false;
        scheduleSync(0);
      } else {
        scheduleSync(CYCLE_MS);
      }
    }
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function linkProfiles(app: ScopeState) {
  const s = useBrowser.getState();
  const remote = [...visible(app, "prof:")].map(([k, v]) => [k.slice(5), v as ProfileRecord] as const);
  const taken = new Set(Object.values(doc.profiles).map((l) => l.syncId));
  for (const id of s.profileOrder) {
    const profile = s.profiles[id];
    if (!profile || isIncognitoProfile(id) || doc.profiles[id]) continue;
    const match = doc.joining
      ? remote.find(([syncId, r]) => !taken.has(syncId) && (id === DEFAULT_PROFILE_ID ? r.d : r.n === profile.name))?.[0]
      : undefined;
    const syncId = match ?? SyncNative!.newDeviceId();
    doc.profiles[id] = { syncId, enabled: true };
    taken.add(syncId);
    // Read the existing chain before publishing local sync data.
    if (match) doc.scopes[`p:${syncId}`] = { ...emptyScope(), awaitRemote: true };
  }
  for (const [id, link] of Object.entries(doc.profiles)) if (!s.profiles[id] && !link.retire) link.retire = true;
}

async function resetFromElsewhere() {
  saveGeneration++;
  savedState = null;
  await SyncNative?.forget(doc.deviceId!);
  doc = { ...emptyDoc(), folder: doc.folder, types: doc.types };
  stateLoaded = true;
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
  for (const [profileId, link] of Object.entries(doc.profiles)) {
    const scope = doc.scopes[`p:${link.syncId}`];
    if (!scope || !link.enabled) continue;
    remoteTabs[profileId] = [...visible(scope, "tabs:")]
      .map(([k, v]) => ({ deviceId: k.slice(5), value: v as DeviceTabs }))
      // A device that stopped syncing took its record away; one without a name record is on its way out.
      .filter(({ deviceId, value }) => deviceId !== doc.deviceId && names.has(deviceId) && value.tabs.length > 0)
      .map(({ deviceId, value }) => ({ deviceId, name: names.get(deviceId) || value.n || "Unknown Device", tabs: value.tabs.map((t) => ({ url: t.u, title: t.t })) }));
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
  if (doc.enabled || quitPaused) return;
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
  saveGeneration++;
  savedState = null;
  metadataLoadError = null;
  doc = { ...emptyDoc(), types: doc.types, enabled: true, folder, deviceId, setupAt: Date.now(), joining };
  stateLoaded = true;
  clearJournal();
  save();
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}

export function turnOnSync(folder: string): Promise<{ ok: true } | { error: string }> {
  if (quitPaused) return Promise.resolve({ error: "Sync is paused while Bay is quitting. Cancel quit to try again." });
  return trackMutation(() => turnOnSyncInternal(folder));
}

async function turnOnSyncInternal(folder: string): Promise<{ ok: true } | { error: string }> {
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

export function enterRecoveryPhrase(folder: string, text: string): Promise<PhraseResult | { error: "unavailable" | "quitting" | "savedData" }> {
  if (quitPaused) return Promise.resolve({ error: "quitting" });
  return trackMutation(() => enterRecoveryPhraseInternal(folder, text));
}

async function enterRecoveryPhraseInternal(folder: string, text: string): Promise<PhraseResult | { error: "unavailable" | "savedData" }> {
  const native = SyncNative;
  if (!native) return { error: "unavailable" };
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, text, doc.folder ?? folder);
    if ("ok" in result) {
      try {
        await loadState();
        publishUi({ status: "starting", error: null });
        scheduleSync(0);
      } catch (error) {
        stateLoaded = false;
        doc.scopes = {};
        publishUi({ status: "locked", error: errorText(error) });
        return { error: "savedData" };
      }
    }
    return result;
  }
  const deviceId = native.newDeviceId();
  const result = await native.enterPhrase(deviceId, text, folder);
  if ("ok" in result) begin(folder, deviceId, true);
  return result;
}

export function stopSync(options: { deleteData?: boolean } = {}): Promise<void> {
  if (quitPaused) return Promise.resolve();
  return trackMutation(() => stopSyncInternal(options));
}

async function stopSyncInternal({ deleteData = false } = {}) {
  const native = SyncNative;
  if (!native || !doc.enabled) return;
  clearTimeout(timer);
  await startup;
  if (activeCycle) await activeCycle;
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
  saveGeneration++;
  savedState = null;
  if (doc.deviceId) await native.forget(doc.deviceId);
  doc = { ...emptyDoc(), folder, types: doc.types };
  stateLoaded = true;
  passwordAdapters.clear();
  clearJournal();
  save();
  publishUi({ status: "off", error: null });
}

export function setTypeSynced(type: DataType, enabled: boolean) {
  if (quitPaused) return;
  doc.types = { ...doc.types, [type]: enabled };
  save();
  publishUi();
  scheduleSync(0);
}

export function setProfileSynced(profileId: string, enabled: boolean) {
  if (quitPaused) return;
  const link = doc.profiles[profileId];
  if (!link) return;
  doc.profiles[profileId] = enabled ? { syncId: link.syncId, enabled } : { ...link, enabled, retire: true };
  save();
  publishUi();
  scheduleSync(0);
}

export function addRemoteProfile(syncId: string): string | null {
  if (quitPaused) return null;
  const record = doc.scopes[APP_SCOPE]?.records[`prof:${syncId}`]?.v as ProfileRecord | undefined;
  if (!record) return null;
  const id = useBrowser.getState().createProfile({ name: record.n, color: record.c, icon: record.i });
  doc.profiles[id] = { syncId, enabled: true };
  doc.scopes[`p:${syncId}`] = { ...emptyScope(), awaitRemote: true };
  save();
  publishUi();
  scheduleSync(0);
  return id;
}

// MARK: Launch

export function startSync() {
  if (!SyncNative || started || quitPaused) return;
  started = true;
  load();
  stateLoaded = !metadataLoadError && !doc.enabled;
  publishUi({ status: metadataLoadError ? "locked" : doc.enabled ? "starting" : "off", error: metadataLoadError?.message ?? null });
  if (!metadataLoadError && doc.enabled && doc.deviceId) {
    const owner = doc;
    startup = (async () => {
      try {
        const ok = await SyncNative.unlock(owner.deviceId!);
        if (doc !== owner) return;
        if (!ok) return publishUi({ status: "locked", error: "Enter your recovery phrase to keep syncing on this Mac." });
        if (await loadState()) {
          publishUi();
          scheduleSync(500);
        }
      } catch (error) {
        if (doc === owner) {
          stateLoaded = false;
          doc.scopes = {};
          publishUi({ status: "locked", error: errorText(error) });
        }
      }
    })();
  }
  useBrowser.subscribe((s, prev) => {
    if (!doc.enabled || running || quitPaused) return;
    if (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.profiles !== prev.profiles || s.groups !== prev.groups) scheduleSync();
  });
  if (__DEV__) {
    (globalThis as { nnSync?: object }).nnSync = {
      useSync, syncNow, turnOnSync, enterRecoveryPhrase, stopSync, setTypeSynced, setProfileSynced, addRemoteProfile, setSyncFolder, folderInfo,
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
