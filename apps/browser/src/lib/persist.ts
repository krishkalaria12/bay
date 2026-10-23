import { restorableClosedEntry, restorableClosedWindow, restorableWindow } from "../store/windowPlacement";
import { cancelDownload, type Download } from "@bay/nncore";
import { readDocument, saveDocument, writeDocument } from "@bay/shell";
import { useBrowser, type BrowserState, type BrowserStore, type HydrateData } from "../store/browser";
import { inPinnedContainer, isIncognitoSpace, makeTab, newId, snapshotTab } from "../store/model";
import type { BrowserWindow, ClosedTab, Tab, TabSnapshot } from "../store/types";
import { isolateSavedSpaces } from "../store/spaces";
import { createFaviconService, startFavicons } from "./favicons";
import { createBookmarksService, startBookmarks } from "./bookmarks";
import { createHistoryService, startHistory } from "./history";
import { createProfileDataCleanup, startProfileDataCleanup } from "./profileData";
import { PERSIST_VERSION, SAVE_DELAY_MS } from "./constants";

type Doc = { name: string; sources: (s: BrowserState) => unknown[]; json: (s: BrowserState) => string };

const serialized =
  (serialize: (s: BrowserState) => unknown) =>
  (s: BrowserState): string =>
    JSON.stringify(serialize(s));

const persistedTab = ({ navigation: _n, adoptId: _a, wakeAdoptId: _w, ...t }: Tab) => t;
const publicTab = (t: { spaceId: string }) => !isIncognitoSpace(t.spaceId);

const DOCS: Doc[] = [
  {
    name: "downloads.json",
    sources: (s) => [s.downloads],
    json: serialized((s) => ({
      version: PERSIST_VERSION,
      downloads: s.downloads.filter((d) => !d.profile || !isIncognitoSpace(d.profile)).map((d) => (d.state === "downloading" ? { ...d, state: "failed" } : d)),
    })),
  },
  {
    name: "session.json",
    sources: (s) => [
      s.spaces,
      s.spaceOrder,
      s.orphanedProfileData,
      s.windows,
      s.windowOrder,
      s.tabs,
      s.tabLists,
      s.groups,
      s.pinnedFolders,
      s.splits,
      s.closedTabs,
      s.closedWindows,
      s.settings,
      s.ui.focusedWindowId,
      s.closedGroups,
      s.deletedGroups,
      s.cleanedTabs,
    ],
    json: serialized((s) => {
      // Private windows, Little Bay and peeks aren't restored: closing (or quitting) throws their pages away.
      const windows = Object.values(s.windows)
        .filter((w) => !w.incognito && w.kind !== "small")
        .map(restorableWindow);
      const kept = new Set(windows.map((w) => w.id));
      const own = (t: Tab) => !isIncognitoSpace(t.spaceId) && s.windows[t.windowId]?.kind !== "small" && !t.peekOf;
      const tabs = Object.values(s.tabs).filter(own);
      const saved = new Set(tabs.map((t) => t.id));
      return {
        version: PERSIST_VERSION,
        spaces: s.spaces,
        spaceOrder: s.spaceOrder,
        orphanedProfileData: s.orphanedProfileData,
        settings: s.settings,
        windows,
        windowOrder: s.windowOrder.filter((id) => kept.has(id)),
        focusedWindowId: s.ui.focusOrder.find((id) => kept.has(id)) ?? null,
        tabs: tabs.map((t) => persistedTab(kept.has(t.windowId) ? t : { ...t, windowId: "" })),
        tabLists: Object.fromEntries(
          Object.entries(s.tabLists)
            .map(([key, ids]) => [key, ids.filter((id) => saved.has(id))])
            .filter(([, ids]) => ids!.length),
        ),
        groups: Object.values(s.groups).filter((g) => !isIncognitoSpace(g.spaceId)),
        pinnedFolders: Object.values(s.pinnedFolders),
        splits: Object.values(s.splits).filter((v) => v.tabIds.every((id) => saved.has(id))),
        // The store keeps private windows out of these lists; filter again so nothing private is ever written.
        closedTabs: s.closedTabs.filter((c) => publicTab(c.tab)),
        closedWindows: s.closedWindows.filter((c) => c.tabs.every(publicTab)).map(restorableClosedEntry),
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
  spaces: HydrateData["spaces"];
  spaceOrder: string[];
  profiles?: Record<string, NonNullable<HydrateData["spaces"]>[string] & { dataId?: string }>;
  profileOrder?: string[];
  orphanedProfileData?: string[];
  settings: HydrateData["settings"];
  windows: BrowserWindow[];
  windowOrder: string[];
  focusedWindowId: string | null;
  tabs: Tab[];
  tabLists?: BrowserState["tabLists"];
  groups: BrowserState["groups"][string][];
  pinnedFolders?: BrowserState["pinnedFolders"][string][];
  parkedPins?: Record<
    string,
    {
      tabs: (TabSnapshot & { id: string; groupId: string | null })[];
      groups: Pick<BrowserState["groups"][string], "id" | "name" | "icon" | "color" | "collapsed">[];
    }
  >;
  splits: BrowserState["splits"][string][];
  closedTabs: ClosedTab[];
  closedWindows: BrowserState["closedWindows"];
  closedGroups?: BrowserState["closedGroups"];
  deletedGroups?: BrowserState["deletedGroups"];
  cleanedTabs?: BrowserState["cleanedTabs"];
};

function locatedInSpace<T extends { spaceId: string }>(value: T & { profileId?: string }): T {
  const { profileId, ...current } = value;
  return { ...current, spaceId: current.spaceId ?? profileId } as T;
}

/** Older builds used profileId for the space and dataId for its native profile. */
function migrateProfileSession(saved: SessionV2): SessionV2 {
  if (saved.spaces || !saved.profiles) return saved;
  const spaces = Object.fromEntries(
    Object.entries(saved.profiles).map(([id, { dataId, ...space }]) => [
      id,
      {
        ...space,
        ...(space.profileId === undefined && dataId !== undefined ? { profileId: dataId, sharesSignIns: space.sharesSignIns ?? true } : {}),
      },
    ]),
  );
  const tabs = (saved.tabs ?? []).map(locatedInSpace);
  const groups = (saved.groups ?? []).map(locatedInSpace);
  const tabIds = new Set(tabs.map((tab) => tab.id));
  // Closed windows used to park their pinned pages outside the live tab map.
  // Space-owned lists retain these pages even without a window showing them.
  for (const [spaceId, parked] of Object.entries(saved.parkedPins ?? {})) {
    const members = new Map<string, string[]>();
    for (const { id, groupId, ...snapshot } of parked.tabs) {
      if (tabIds.has(id)) continue;
      const tab = {
        ...makeTab("", spaceId, snapshot.url, { ...locatedInSpace(snapshot), spaceId, pinned: !groupId }),
        id,
        unloaded: true,
      };
      tabs.push(tab);
      tabIds.add(id);
      if (groupId) members.set(groupId, [...(members.get(groupId) ?? []), id]);
    }
    for (const group of parked.groups) {
      const ids = members.get(group.id);
      if (ids?.length && !groups.some((g) => g.id === group.id)) {
        groups.push({ ...group, spaceId, pinned: true, tabIds: ids, createdAt: Date.now() });
      }
    }
  }
  const closedGroup = (entry: BrowserState["closedGroups"][number]) => ({ ...entry, tabs: entry.tabs.map(locatedInSpace) });
  return {
    ...saved,
    spaces,
    spaceOrder: saved.profileOrder ?? [],
    windows: (saved.windows ?? []).map(locatedInSpace),
    tabs,
    groups,
    closedTabs: (saved.closedTabs ?? []).map((entry) => ({ ...entry, tab: locatedInSpace(entry.tab) })),
    closedWindows: (saved.closedWindows ?? []).map((entry) => ({
      ...entry,
      window: locatedInSpace(entry.window),
      tabs: entry.tabs.map(locatedInSpace),
      groups: entry.groups.map(locatedInSpace),
    })),
    closedGroups: (saved.closedGroups ?? []).map(closedGroup),
    deletedGroups: (saved.deletedGroups ?? []).map(closedGroup),
    cleanedTabs: (saved.cleanedTabs ?? []).map((entry) => ({ ...entry, tab: locatedInSpace(entry.tab) })),
  };
}

function backupBeforeIsolation(name: string) {
  const original = readDocument(name);
  const backup = `${name.replace(/\.json$/, "")}.before-space-isolation.json`;
  if (original && !readDocument(backup)) writeDocument(backup, original);
}

// Older cache files used space IDs even when several spaces shared one native profile.
// Keep those records with the original owner before the native cache migrations run.
function isolateLegacyFiles(owners: Map<string, string[]>, detached: Set<string>) {
  for (const name of ["history.json", "bookmarks.json"]) {
    const file = read<{ history?: BrowserState["history"]; bookmarks?: BrowserState["bookmarks"] }>(name);
    if (!file) continue;
    backupBeforeIsolation(name);
    if (file.history) {
      const history = { ...file.history };
      for (const [owner, ids] of owners) {
        const source = [owner, ...ids].find((id) => history[id]);
        if (source) history[owner] = history[source]!;
      }
      for (const id of detached) delete history[id];
      file.history = history;
    }
    if (file.bookmarks) {
      const roots = { ...file.bookmarks.roots };
      for (const [owner, ids] of owners) {
        const source = [owner, ...ids].find((id) => roots[id]);
        if (source) roots[owner] = roots[source]!;
      }
      for (const id of detached) delete roots[id];
      file.bookmarks = { ...file.bookmarks, roots };
    }
    writeDocument(name, JSON.stringify(file));
  }
}

export function loadSession(): HydrateData | null {
  const saved = read<SessionV2>("session.json");
  if (saved?.version !== 2) return null;
  const session = migrateProfileSession(saved);
  const spaces = session.spaces ?? session.profiles;
  const spaceOrder = session.spaceOrder ?? session.profileOrder ?? [];
  if (spaces) {
    const order = [...new Set([...spaceOrder.filter((id) => spaces[id]), ...Object.keys(spaces)])];
    const { owners, detached } = isolateSavedSpaces(spaces, order, session.orphanedProfileData ?? []);
    if (detached.size || session !== saved) backupBeforeIsolation("session.json");
    if (detached.size) isolateLegacyFiles(owners, detached);
  }
  const downloads = read<{ downloads: Download[] }>("downloads.json");
  const data: HydrateData = {
    spaces,
    spaceOrder,
    orphanedProfileData: session.orphanedProfileData ?? [],
    settings: session.settings,
    windows: byId(session.windows.map(restorableWindow)),
    windowOrder: session.windowOrder,
    focusedWindowId: session.focusedWindowId,
    tabs: byId(session.tabs),
    tabLists: session.tabLists ?? {},
    groups: byId(session.groups),
    pinnedFolders: byId(session.pinnedFolders),
    splits: byId(session.splits),
    closedTabs: session.closedTabs,
    closedWindows: session.closedWindows?.map(restorableClosedEntry),
    closedGroups: session.closedGroups ?? [],
    deletedGroups: session.deletedGroups ?? [],
    cleanedTabs: session.cleanedTabs ?? [],
    downloads: (downloads?.downloads ?? []).map((d, i) => ({ ...d, id: `saved-${i}` })),
    launch: true,
  };
  if (session.settings && session.settings.restoreSession === false) {
    // A launch that doesn't restore the last session: each space keeps its pinned tabs, and its other tabs wait in
    // Recently Closed, one window's worth per space (where a window showed it).
    const now = Date.now();
    const pinSource = { tabs: data.tabs ?? {}, groups: data.groups ?? {} };
    const loose = Object.values(data.tabs ?? {}).filter((t) => !inPinnedContainer(pinSource, t.id));
    const shownAt = (spaceId: string) => session.windows.find((w) => w.spaceId === spaceId) ?? session.windows[0];
    const bySpace = new Map<string, Tab[]>();
    for (const t of loose) bySpace.set(t.spaceId, [...(bySpace.get(t.spaceId) ?? []), t]);
    data.closedWindows = [
      ...(data.closedWindows ?? []),
      ...[...bySpace]
        .map(([spaceId, tabs]) => {
          const w = shownAt(spaceId);
          return {
            kind: "window" as const,
            id: newId("cw"),
            window: restorableClosedWindow({ ...w, spaceId, sidebarOpen: w?.sidebarOpen ?? true, frame: w?.frame ?? null }),
            tabs: tabs.map((t) => ({ ...snapshotTab(t), active: session.windows.some((x) => x.activeTabIds[spaceId] === t.id) })),
            groups: [],
            closedAt: now,
          };
        })
        .filter((c) => c.tabs.some((t) => t.url)),
    ].slice(-10);
    const gone = new Set(loose.map((t) => t.id));
    data.windows = {};
    data.windowOrder = [];
    data.tabs = Object.fromEntries(Object.entries(data.tabs ?? {}).filter(([id]) => !gone.has(id)));
  }
  return data;
}

export type PersistenceOwner = {
  flush(options?: { final?: boolean }): Promise<void>;
  resume(): void;
  dispose(): void;
};

/** Restore disk state before creating the shared authority. Recovery skips this. */
export function restoreBrowserSession(store: BrowserStore) {
  const session = loadSession();
  store.getState().hydrate(session ?? {});
  return session;
}

/** Owns session/download persistence for one authority store. Global history,
 * bookmark, favicon and profile services are started separately by its caller.
 */
export function createPersistence({ store, restoreSession = true }: { store: BrowserStore; restoreSession?: boolean }): PersistenceOwner {
  const session = restoreSession ? restoreBrowserSession(store) : null;
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
        try {
          saved = Promise.resolve(saveDocument(doc.name, json));
        } catch (error) {
          saved = Promise.reject(error);
        }
        pending.push(
          saved.then(
            () => {
              if (!disposed && savingGeneration === generation) lastJson.set(doc.name, json);
            },
            (error) => {
              if (!disposed && savingGeneration === generation) {
                lastJson.delete(doc.name);
                dirty.add(doc);
              }
              throw error;
            },
          ),
        );
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
    if (dirty.size && !timer)
      timer = setTimeout(() => {
        try {
          void save().catch((error) => console.warn("Couldn't save the session", error));
        } catch (error) {
          console.warn("Couldn't save the session", error);
        }
      }, SAVE_DELAY_MS);
  }
  check(store.getState(), true);
  // A session saved with profiles, or before its spaces were isolated, is written once in its current shape.
  if (
    session?.spaces &&
    (!read<SessionV2>("session.json")?.spaces ||
      Object.entries(session.spaces).some(([id, space]) => space.profileId !== store.getState().spaces[id]?.profileId))
  ) {
    dirty.add(DOCS.find((doc) => doc.name === "session.json")!);
    try {
      void save().catch((error) => console.warn("Couldn't save the session", error));
    } catch (error) {
      console.warn("Couldn't save the session", error);
    }
  }
  const unsubscribe = store.subscribe((_state, previous) => {
    // Space/private-window cleanup can produce nested updates before this
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
        try {
          finalFlush = save(true, snapshot);
        } catch (error) {
          finalFlush = Promise.reject(error);
        }
        return finalFlush;
      }
      try {
        return save();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    resume() {
      if (disposed) return;
      generation++;
      frozen = false;
      finalFlush = null;
      check(store.getState());
      try {
        void save().catch((error) => console.warn("Couldn't save the session", error));
      } catch (error) {
        console.warn("Couldn't save the session", error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      unsubscribe();
      dirty.clear();
      lastSources.clear();
      lastJson.clear();
      finalFlush = null;
    },
  };
}

let defaultPersistence: PersistenceOwner | null = null;
let stopDefault: (() => void) | null = null;
export function flushPersistence(options: { final?: boolean } = {}) {
  return defaultPersistence?.flush(options) ?? Promise.resolve();
}

// A page's beforeunload cancelled quit. Resume from whatever changed meanwhile.
export function resumePersistence() {
  defaultPersistence?.resume();
}

/** All document/native-data watchers belong to the same authority store. */
export function createBrowserPersistence({ store, restoreSession = true }: { store: BrowserStore; restoreSession?: boolean }): PersistenceOwner {
  const owner = createPersistence({ store, restoreSession });
  const stops: (() => void)[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      for (const stopService of stops.reverse()) {
        try {
          stopService();
        } catch (error) {
          console.error("[runtime] persistence service cleanup failed", error);
        }
      }
    } finally {
      owner.dispose();
    }
  };
  try {
    stops.push(store === useBrowser ? startFavicons() : createFaviconService(store).start());
    stops.push(store === useBrowser ? startHistory() : createHistoryService(store).start());
    stops.push(store === useBrowser ? startBookmarks() : createBookmarksService(store).start());
    stops.push(store === useBrowser ? startProfileDataCleanup() : createProfileDataCleanup(store).start());
  } catch (error) {
    stop();
    throw error;
  }
  return { flush: owner.flush, resume: owner.resume, dispose: stop };
}

/** Compatibility entry for the single-runtime host and existing integrations. */
export function startPersistence() {
  stopDefault?.();
  const owner = createBrowserPersistence({ store: useBrowser });
  defaultPersistence = owner;
  const stop = () => {
    owner.dispose();
    if (defaultPersistence === owner) defaultPersistence = null;
    if (stopDefault === stop) stopDefault = null;
  };
  stopDefault = stop;
  return stop;
}

function forgetClosedIncognito(s: BrowserState, prev: BrowserState) {
  for (const w of Object.values(prev.windows)) {
    if (!w.incognito || s.windows[w.id]) continue;
    for (const d of s.downloads) if (d.profile === w.spaceId && d.state === "downloading") void cancelDownload(d.id);
    s.forgetDownloads(w.spaceId);
  }
}
