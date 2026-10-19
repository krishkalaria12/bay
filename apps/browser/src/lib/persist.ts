import { cancelDownload, type Download } from "@bay/nncore";
import { readDocument, saveDocument, writeDocument } from "@bay/shell";
import { useBrowser, type BrowserState, type BrowserStore, type HydrateData } from "../store/browser";
import { inPinnedContainer, isIncognitoProfile, newId, snapshotTab } from "../store/model";
import { parkWindowPins } from "../store/parkedPins";
import type { BrowserWindow, ClosedTab, Tab } from "../store/types";
import { startFavicons } from "./favicons";
import { startBookmarks } from "./bookmarks";
import { startHistory } from "./history";
import { startProfileDataCleanup } from "./profileData";

const SAVE_DELAY_MS = 800;
const VERSION = 2;

type Doc = { name: string; sources: (s: BrowserState) => unknown[]; json: (s: BrowserState) => string };

const serialized =
  (serialize: (s: BrowserState) => unknown) =>
  (s: BrowserState): string =>
    JSON.stringify(serialize(s));

const persistedTab = ({ navigation: _n, adoptId: _a, wakeAdoptId: _w, ...t }: Tab) => t;
const publicTab = (t: { profileId: string }) => !isIncognitoProfile(t.profileId);

const DOCS: Doc[] = [
  {
    name: "downloads.json",
    sources: (s) => [s.downloads],
    json: serialized((s) => ({
      version: VERSION,
      downloads: s.downloads
        .filter((d) => !d.profile || !isIncognitoProfile(d.profile))
        .map((d) => (d.state === "downloading" ? { ...d, state: "failed" } : d)),
    })),
  },
  {
    name: "session.json",
    sources: (s) => [s.profiles, s.profileOrder, s.orphanedProfileData, s.windows, s.windowOrder, s.tabs, s.groups, s.splits, s.closedTabs, s.closedWindows, s.parkedPins, s.settings, s.ui.focusedWindowId, s.closedGroups, s.deletedGroups, s.cleanedTabs],
    json: serialized((s) => {
      // Harbor windows aren't restored: closing (or quitting) throws their page away.
      const windows = Object.values(s.windows).filter((w) => !w.incognito && w.kind !== "small");
      const kept = new Set(windows.map((w) => w.id));
      return {
        version: VERSION,
        profiles: s.profiles,
        profileOrder: s.profileOrder,
        orphanedProfileData: s.orphanedProfileData,
        settings: s.settings,
        windows,
        windowOrder: s.windowOrder.filter((id) => kept.has(id)),
        focusedWindowId: s.ui.focusOrder.find((id) => kept.has(id)) ?? null,
        tabs: Object.values(s.tabs).filter((t) => kept.has(t.windowId)).map(persistedTab),
        groups: Object.values(s.groups).filter((g) => kept.has(g.windowId)),
        splits: Object.values(s.splits).filter((v) => kept.has(v.windowId)),
        // The store keeps private windows out of these lists; filter again so nothing private is ever written.
        closedTabs: s.closedTabs.filter((c) => publicTab(c.tab)),
        closedWindows: s.closedWindows.filter((c) => c.tabs.every(publicTab)),
        parkedPins: Object.fromEntries(Object.entries(s.parkedPins).filter(([profileId]) => publicTab({ profileId }))),
        closedGroups: s.closedGroups.filter((c) => c.tabs.every(publicTab)),
        deletedGroups: s.deletedGroups.filter((c) => c.tabs.every(publicTab)),
        cleanedTabs: s.cleanedTabs.filter((c) => publicTab(c.tab)),
      };
    }),
  },
];

function read<T>(name: string): T | null {
  try {
    const json = readDocument(name);
    return json ? (JSON.parse(json) as T) : null;
  } catch (error) {
    console.warn(`Couldn't read ${name}`, error);
    return null;
  }
}

function write(name: string, json: string) {
  try {
    writeDocument(name, json);
  } catch (error) {
    console.warn(`Couldn't save ${name}`, error);
  }
}

const byId = <T extends { id: string }>(list: T[] | undefined) => Object.fromEntries((list ?? []).map((x) => [x.id, x]));

type SessionV2 = {
  version: 2;
  profiles: HydrateData["profiles"];
  profileOrder: string[];
  orphanedProfileData?: string[];
  settings: HydrateData["settings"];
  windows: BrowserWindow[];
  windowOrder: string[];
  focusedWindowId: string | null;
  tabs: Tab[];
  groups: BrowserState["groups"][string][];
  splits: BrowserState["splits"][string][];
  closedTabs: ClosedTab[];
  closedWindows: BrowserState["closedWindows"];
  parkedPins?: BrowserState["parkedPins"];
  closedGroups?: BrowserState["closedGroups"];
  deletedGroups?: BrowserState["deletedGroups"];
  cleanedTabs?: BrowserState["cleanedTabs"];
};

export function loadSession(): HydrateData | null {
  const session = read<SessionV2>("session.json");
  if (session?.version !== 2) return null;
  const downloads = read<{ downloads: Download[] }>("downloads.json");
  const data: HydrateData = {
    profiles: session.profiles,
    profileOrder: session.profileOrder,
    orphanedProfileData: session.orphanedProfileData ?? [],
    settings: session.settings,
    windows: byId(session.windows),
    windowOrder: session.windowOrder,
    focusedWindowId: session.focusedWindowId,
    tabs: byId(session.tabs),
    groups: byId(session.groups),
    splits: byId(session.splits),
    closedTabs: session.closedTabs,
    closedWindows: session.closedWindows,
    parkedPins: session.parkedPins ?? {},
    closedGroups: session.closedGroups ?? [],
    deletedGroups: session.deletedGroups ?? [],
    cleanedTabs: session.cleanedTabs ?? [],
    downloads: (downloads?.downloads ?? []).map((d, i) => ({ ...d, id: `saved-${i}` })),
  };
  if (session.settings && session.settings.restoreSession === false) {
    const now = Date.now();
    const pinSource = { tabs: data.tabs ?? {}, groups: data.groups ?? {}, history: {} };
    for (const w of session.windows) data.parkedPins = parkWindowPins(data.parkedPins ?? {}, w, pinSource);
    data.closedWindows = [
      ...(data.closedWindows ?? []),
      ...session.windows.map((w) => ({
        kind: "window" as const,
        id: newId("cw"),
        window: { profileId: w.profileId, sidebarOpen: w.sidebarOpen, frame: w.frame },
        tabs: w.tabIds
          .map((id) => data.tabs?.[id])
          .filter((t): t is Tab => !!t && !inPinnedContainer(pinSource, t.id))
          .map((t) => ({ ...snapshotTab(t), active: Object.values(w.activeTabIds).includes(t.id) })),
        groups: [],
        closedAt: now,
      })).filter((c) => c.tabs.some((t) => t.url)),
    ].slice(-10);
    data.windows = {};
    data.windowOrder = [];
    data.tabs = {};
  }
  return data;
}

export type PersistenceOwner = {
  flush(options?: { final?: boolean }): Promise<void>;
  resume(): void;
  dispose(): void;
};

/** Owns session/download persistence for one authority store. Global history,
 * bookmark, favicon and profile services are started separately by its caller.
 */
export function createPersistence({ store, restoreSession = true }: { store: BrowserStore; restoreSession?: boolean }): PersistenceOwner {
  if (restoreSession) store.getState().hydrate(loadSession() ?? {});
  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let finalFlush: Promise<void> | null = null;
  let frozen = false;
  let disposed = false;

  function save(final = false, snapshot = store.getState()): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return Promise.reject(new Error("Persistence owner is disposed"));
    if (frozen && !final) return finalFlush ?? Promise.resolve();
    const savingGeneration = generation;
    const pending: Promise<void>[] = [];
    for (const doc of DOCS.filter((d) => final || dirty.has(d))) {
      const json = doc.json(snapshot);
      if (final) {
        // Re-save every final document, including a previous background write
        // whose completion is otherwise unknown on an asynchronous host.
        let saved: Promise<void>;
        try { saved = Promise.resolve(saveDocument(doc.name, json)); }
        catch (error) { saved = Promise.reject(error); }
        pending.push(saved.then(() => {
          if (!disposed && savingGeneration === generation) lastJson.set(doc.name, json);
        }, (error) => {
          if (!disposed && savingGeneration === generation) {
            lastJson.delete(doc.name);
            dirty.add(doc);
          }
          throw error;
        }));
      } else if (lastJson.get(doc.name) !== json) {
        lastJson.set(doc.name, json);
        write(doc.name, json);
      }
    }
    dirty.clear();
    return Promise.all(pending).then(() => {});
  }
  function check(state: BrowserState, initial = false) {
    if (disposed || frozen) return;
    for (const doc of DOCS) {
      const sources = doc.sources(state);
      const previous = lastSources.get(doc.name);
      if (previous && sources.every((value, index) => value === previous[index])) continue;
      lastSources.set(doc.name, sources);
      if (!initial) dirty.add(doc);
    }
    if (dirty.size && !timer) timer = setTimeout(() => {
      try { void save().catch((error) => console.warn("Couldn't save the session", error)); }
      catch (error) { console.warn("Couldn't save the session", error); }
    }, SAVE_DELAY_MS);
  }
  check(store.getState(), true);
  const unsubscribe = store.subscribe((_state, previous) => {
    // Profile/private-window cleanup can produce nested updates before this
    // subscriber runs, so save the current state rather than the outer event.
    const state = store.getState();
    check(state);
    if (state.windows !== previous.windows) forgetClosedIncognito(state, previous);
  });
  return {
    flush({ final = false } = {}) {
      if (disposed) return Promise.reject(new Error("Persistence owner is disposed"));
      if (final) {
        if (finalFlush) return finalFlush;
        // Capture before freezing. Window closure during quit must not replace
        // this snapshot while its acknowledged writes are still in flight.
        const snapshot = store.getState();
        frozen = true;
        try { finalFlush = save(true, snapshot); }
        catch (error) { finalFlush = Promise.reject(error); }
        return finalFlush;
      }
      try { return save(); } catch (error) { return Promise.reject(error); }
    },
    resume() {
      if (disposed) return;
      generation++;
      frozen = false;
      finalFlush = null;
      check(store.getState());
      try { void save().catch((error) => console.warn("Couldn't save the session", error)); }
      catch (error) { console.warn("Couldn't save the session", error); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      unsubscribe();
      dirty.clear(); lastSources.clear(); lastJson.clear(); finalFlush = null;
    },
  };
}

let defaultPersistence: PersistenceOwner | null = null;
let stopDefault: (() => void) | null = null;
export function flushPersistence(options: { final?: boolean } = {}) {
  return defaultPersistence?.flush(options) ?? Promise.resolve();
}

// A page's beforeunload cancelled quit. Resume from whatever changed meanwhile.
export function resumePersistence() { defaultPersistence?.resume(); }

/** macOS compatibility entry. These services still use the default store; an
 * isolated coordinator must start its own parameterized services explicitly.
 */
export function startPersistence() {
  stopDefault?.();
  const owner = createPersistence({ store: useBrowser });
  defaultPersistence = owner;
  const stops: (() => void)[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { for (const stopService of stops) stopService(); }
    finally {
      owner.dispose();
      if (defaultPersistence === owner) defaultPersistence = null;
      if (stopDefault === stop) stopDefault = null;
    }
  };
  stopDefault = stop;
  try {
    stops.push(startFavicons());
    stops.push(startHistory());
    stops.push(startBookmarks());
    stops.push(startProfileDataCleanup());
  } catch (error) { stop(); throw error; }
  return stop;
}

function forgetClosedIncognito(s: BrowserState, prev: BrowserState) {
  for (const w of Object.values(prev.windows)) {
    if (!w.incognito || s.windows[w.id]) continue;
    for (const d of s.downloads) if (d.profile === w.profileId && d.state === "downloading") void cancelDownload(d.id);
    s.forgetDownloads(w.profileId);
  }
}
