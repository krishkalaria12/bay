import { cancelDownload, endWebKitPrivateSession, isJsReload, type Download } from "@bay/chromium";
import { readDocument, saveDocument, writeDocument } from "@bay/desktop";
import { useBrowser, type BrowserState, type BrowserStore, type HydrateData } from "../store/browserStore";
import { inPinnedContainer, isIncognitoSpace, makeTab, newId, snapshotTab } from "../store/model";
import type { BrowserWindow, ClosedTab, Tab, TabSnapshot } from "../store/types";
import { isolateSavedSpaces } from "../store/spaces";
import { normalizeLocalFiles } from "../store/localFiles";
import { restorableClosedEntry, restorableClosedWindow, restorableWindow } from "../store/windowPlacement";
import { PERSIST_VERSION, SAVE_DELAY_MS } from "./constants";
import { startBoosts } from "../components/boosts/state";
import { readLibrary } from "../components/library/libraryService";
import { createFaviconService } from "./favicons";
import type { SavedDocument } from "./savedDocument";

// The app's documents: what they hold and how they are written, and the saving that writes them.
//
// The saving is the app's one writer. There is one owner per store, one subscription to that store, one timer and
// one quit handshake: the coordinator (runtime/services.ts) owns it, and a second start for the same store finds the
// same owner, so a session is never written twice.

export type Doc = { name: string; sources: (s: BrowserState) => unknown[]; json: (s: BrowserState) => string };

const serialized =
  <T>(serialize: (s: BrowserState) => T) =>
  (s: BrowserState): string =>
    JSON.stringify(serialize(s));

const persistedTab = ({ navigation: _n, adoptId: _a, wakeAdoptId: _w, ...t }: Tab) => t;
const publicTab = (t: { spaceId: string }) => !isIncognitoSpace(t.spaceId);

// Tabs are almost all of session.json (~65 KB of 70 KB with 200 tabs), and a save follows most interactions (a tab
// switch stamps lastActiveAt). Each tab's JSON is kept with its record, so a save stringifies only the tabs that
// changed: the string is what JSON.stringify of the whole document would write.
const tabJson = new WeakMap<Tab, string>();

// Closing a window leaves its tabs in their space. Keep their detached JSON too; a record's owner can disappear
// or return without changing the record, so neither representation can stand in for the other.
const detachedTabJson = new WeakMap<Tab, string>();

function persistedTabJson(t: Tab, detached: boolean): string {
  const cache = detached ? detachedTabJson : tabJson;
  let json = cache.get(t);

  if (json === undefined) cache.set(t, (json = JSON.stringify(persistedTab(detached ? { ...t, windowId: "" } : t))));

  return json;
}

/** An object's JSON from its fields' JSON, in order; a field whose JSON is undefined is left out, as JSON.stringify does. */
function objectJson(fields: [string, string | undefined][]): string {
  const parts: string[] = [];

  for (const [key, json] of fields) {
    if (json === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${json}`);
  }

  return `{${parts.join(",")}}`;
}

/** session.json's document. */
export function sessionJson(s: BrowserState): string {
  // Private windows, Little Bay and peeks aren't restored: closing (or quitting) throws their pages away.
  // A host without global coordinates writes only the placement it can restore: size and maximized, never a frame.
  const windows = Object.values(s.windows)
    .filter((w) => !w.incognito && w.kind !== "small")
    .map(restorableWindow);

  const kept = new Set(windows.map((w) => w.id));
  const own = (t: Tab) => !isIncognitoSpace(t.spaceId) && s.windows[t.windowId]?.kind !== "small" && !t.peekOf;
  const tabs = Object.values(s.tabs).filter(own);
  const saved = new Set(tabs.map((t) => t.id));

  // SAFETY: JSON.stringify returns undefined only for undefined, functions and symbols, which the fields never hold.
  const json = <T>(value: T) => JSON.stringify(value) as string | undefined;

  return objectJson([
    ["version", json(PERSIST_VERSION)],
    ["spaces", json(s.spaces)],
    ["spaceOrder", json(s.spaceOrder)],
    ["orphanedProfileData", json(s.orphanedProfileData)],
    ["settings", json(s.settings)],
    ["windows", json(windows)],
    ["windowOrder", json(s.windowOrder.filter((id) => kept.has(id)))],
    ["focusedWindowId", json(s.ui.focusOrder.find((id) => kept.has(id)) ?? null)],
    ["tabs", `[${tabs.map((t) => persistedTabJson(t, !kept.has(t.windowId))).join(",")}]`],
    [
      "tabLists",
      json(
        Object.fromEntries(
          Object.entries(s.tabLists)
            .map(([key, ids]) => [key, ids.filter((id) => saved.has(id))])
            .filter(([, ids]) => ids!.length),
        ),
      ),
    ],
    ["groups", json(Object.values(s.groups).filter((g) => !isIncognitoSpace(g.spaceId)))],
    ["pinnedFolders", json(Object.values(s.pinnedFolders))],
    ["localFiles", json(Object.values(normalizeLocalFiles(s.localFiles, s.spaces)))],
    ["splits", json(Object.values(s.splits).filter((v) => v.tabIds.every((id) => saved.has(id))))],
    // The store keeps private windows out of these lists; filter again so nothing private is ever written.
    ["closedTabs", json(s.closedTabs.filter((c) => publicTab(c.tab)))],
    ["closedWindows", json(s.closedWindows.filter((c) => c.tabs.every(publicTab)).map(restorableClosedEntry))],
    ["closedGroups", json(s.closedGroups.filter((c) => c.tabs.every(publicTab)))],
    ["deletedGroups", json(s.deletedGroups.filter((c) => c.tabs.every(publicTab)))],
    ["cleanedTabs", json(s.cleanedTabs.filter((c) => publicTab(c.tab)))],
  ]);
}

export const DOCS: Doc[] = [
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
      s.localFiles,
      s.splits,
      s.closedTabs,
      s.closedWindows,
      s.settings,
      s.ui.focusedWindowId,
      s.closedGroups,
      s.deletedGroups,
      s.cleanedTabs,
    ],
    json: sessionJson,
  },
];

function read<T>(name: string): T | null {
  try {
    const json = readDocument(name);

    // SAFETY: JSON.parse yields the persisted document shape written by write for this name; callers check version.
    return json ? (JSON.parse(json) as T) : null;
  } catch (error) {
    console.warn(`Couldn't read ${name}`, error);

    return null;
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
  localFiles?: BrowserState["localFiles"][string][];
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

/** A record that named its space by its old id: the space it belongs to now. */
function locatedInSpace<T extends { spaceId: string }>(value: T & { profileId?: string }): T {
  const { profileId, ...current } = value;

  // SAFETY: the checks above established this shape.
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
        ...(space.profileId === undefined && dataId !== undefined ? { profileId: dataId, sharesSignIns: space.sharesSignIns ?? true } : undefined),
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
  // A JS reload isn't a launch: each window's page is parked for it to show again (NNCoreWebView), and one not shown soon
  // closes, so windows keep the tabs they showed whatever settings.launchTab and restoreSession say.
  const reloaded = isJsReload();
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
    localFiles: normalizeLocalFiles(Object.fromEntries((session.localFiles ?? []).map((pin, index) => [String(index), pin])), spaces),
    splits: byId(session.splits),
    closedTabs: session.closedTabs,
    closedWindows: session.closedWindows?.map(restorableClosedEntry),
    closedGroups: session.closedGroups ?? [],
    deletedGroups: session.deletedGroups ?? [],
    cleanedTabs: session.cleanedTabs ?? [],
    downloads: (downloads?.downloads ?? []).map((d, i) => ({ ...d, id: `saved-${i}` })),
    launch: !reloaded,
  };

  if (!reloaded && session.settings && session.settings.restoreSession === false) {
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
      ...[...bySpace].flatMap(([spaceId, tabs]) => {
        const w = shownAt(spaceId);

        const closedWindow = {
          kind: "window" as const,
          id: newId("cw"),
          window: restorableClosedWindow({ ...w, spaceId, sidebarOpen: w?.sidebarOpen ?? true, frame: w?.frame ?? null }),
          tabs: tabs.map((t) => ({ ...snapshotTab(t), active: session.windows.some((x) => x.activeTabIds[spaceId] === t.id) })),
          groups: [],
          closedAt: now,
        };

        return closedWindow.tabs.some((t) => t.url) ? [closedWindow] : [];
      }),
    ].slice(-10);
    const gone = new Set(loose.map((t) => t.id));
    data.windows = {};
    data.windowOrder = [];
    data.tabs = Object.fromEntries(Object.entries(data.tabs ?? {}).filter(([id]) => !gone.has(id)));
  }

  return data;
}

/**
 * The saved session no longer matches the store: the spaces were isolated, or the file was written by an older
 * version. The session is written again before anything else.
 */
export function sessionNeedsRewrite(session: HydrateData | null, store: BrowserStore = useBrowser): boolean {
  if (!session?.spaces) return false;

  if (!read<SessionV2>("session.json")?.spaces) return true;

  const spaces = store.getState().spaces;

  return Object.entries(session.spaces).some(([id, space]) => space.profileId !== spaces[id]?.profileId);
}

/** A private window's downloads and its pages' site data go with it. */
export function forgetClosedIncognito(s: BrowserState, prev: BrowserState) {
  for (const w of Object.values(prev.windows)) {
    if (!w.incognito || s.windows[w.id]) continue;

    for (const d of s.downloads) if (d.profile === w.spaceId && d.state === "downloading") void cancelDownload(d.id);
    s.forgetDownloads(w.spaceId);
    // Its WebKit pages' cookies and site data, kept in memory for the window, go with it.
    void endWebKitPrivateSession(w.spaceId);
  }
}

// MARK: The saving

/** The app's saving, as the quit handshake and the runtime reach it. */
export type PersistenceOwner = {
  /** Writes every document that changed, now. */
  flush(options?: { final?: boolean }): Promise<void>;
  /** The quit was cancelled: saving goes on, starting with what changed meanwhile. */
  resume(): void;
  /** Gives the saving back: the subscription, the timer and the services it holds. */
  dispose(): void;
};

/** Loads the saved session into the given store and returns it. */
export function restoreBrowserSession(store: BrowserStore) {
  const session = loadSession();

  store.getState().hydrate(session ?? {});
  readLibrary();
  startBoosts();

  return session;
}

/** What one store's saving holds: the owner itself, and what it has to give back. */
type Saved = {
  readonly owner: PersistenceOwner;
  /** The stops the saving holds: the store subscription, the timer and the services it started. */
  readonly stops: (() => void)[];
  /** Adds documents another store keeps, so they are written with the session's. */
  readonly addDocuments: (documents: readonly SavedDocument[]) => void;
  /** Whether the store's own services (the favicons) are running. */
  services: boolean;
};

/** The saving each store has. One store, one owner: a second start finds the first. */
const saved = new WeakMap<BrowserStore, Saved>();

const writeNow = (name: string, json: string): boolean => {
  try {
    writeDocument(name, json);

    return true;
  } catch (error) {
    console.warn(`Couldn't save ${name}`, error);

    return false;
  }
};

function createSaved({ store, restoreSession, documents }: { store: BrowserStore; restoreSession: boolean; documents: readonly SavedDocument[] }): Saved {
  // What the saving remembers between changes: the last source values it compared, the last contents it wrote, and
  // the documents it still owes.
  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  const dirtyOther = new Set<SavedDocument>();
  const extra = new Set<SavedDocument>();
  const stops: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  // From the quit's last save until the quit ends or is called off: what the quit itself does to the store is never saved.
  let frozen = false;
  let disposed = false;
  // A generation counts the writes that are still on their way: a resumed save does not answer for the frozen one.
  let generation = 0;
  let finalFlush: Promise<void> | null = null;
  let finalSnapshot: BrowserState | undefined;

  // The write the disk acknowledges: the quit waits for it, so the session is on disk before the app goes.
  const acknowledge = (name: string, json: string, saving: number, failed: () => void): Promise<void> => {
    let written: Promise<void>;

    try {
      written = Promise.resolve(saveDocument(name, json));
    } catch (error) {
      written = Promise.reject(error);
    }

    return written.then(
      () => {
        if (!disposed && saving === generation) lastJson.set(name, json);
      },
      (error) => {
        // A write that fails stays owed: the next save tries it again.
        if (!disposed && saving === generation) {
          lastJson.delete(name);
          failed();
        }

        throw error;
      },
    );
  };

  const save = (final = false, snapshot = store.getState()): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;

    if (disposed) return Promise.reject(new Error("Persistence owner is disposed"));

    if (frozen && !final) return finalFlush ?? Promise.resolve();

    const saving = generation;
    const pending: Promise<void>[] = [];

    for (const doc of DOCS) {
      if (!final && !dirty.has(doc)) continue;

      const json = doc.json(snapshot);

      if (final) {
        // The quit's last write: every document is written again, and the disk acknowledges each one.
        pending.push(
          acknowledge(doc.name, json, saving, () => {
            dirty.add(doc);
          }),
        );
        continue;
      }

      if (lastJson.get(doc.name) === json) {
        dirty.delete(doc);
        continue;
      }

      if (!writeNow(doc.name, json)) continue;

      lastJson.set(doc.name, json);
      dirty.delete(doc);
    }

    for (const doc of final ? extra : dirtyOther) {
      const json = doc.json();

      if (lastJson.get(doc.name) === json) {
        dirtyOther.delete(doc);
        continue;
      }

      if (final) {
        pending.push(
          acknowledge(doc.name, json, saving, () => {
            dirtyOther.add(doc);
          }),
        );
        continue;
      }

      if (!writeNow(doc.name, json)) continue;

      lastJson.set(doc.name, json);
      dirtyOther.delete(doc);
    }

    // A failed acknowledgement does not mean the other accepted native writes have settled yet.
    return Promise.allSettled(pending).then((results) => {
      const failed = results.find((result) => result.status === "rejected");

      if (failed?.status === "rejected") throw failed.reason;
    });
  };

  const saveSoon = () => {
    if (frozen || timer) return;

    timer = setTimeout(() => {
      void save().catch((error) => console.warn("Couldn't save the session", error));
    }, SAVE_DELAY_MS);
  };

  const check = (state: BrowserState, initial = false) => {
    if (disposed || frozen) return;

    for (const doc of DOCS) {
      const sources = doc.sources(state);
      const previous = lastSources.get(doc.name);

      if (previous && sources.every((value, index) => value === previous[index])) continue;
      lastSources.set(doc.name, sources);

      if (!initial) dirty.add(doc);
    }

    if (dirty.size) saveSoon();
  };

  // Another store's document changed: it is written with the session's, after the same wait.
  // While the quit is saving, the change waits: a cancelled quit writes it when saving resumes.
  const otherChanged = (doc: SavedDocument) => {
    dirtyOther.add(doc);

    saveSoon();
  };

  const addDocuments = (documents: readonly SavedDocument[]) => {
    for (const doc of documents) {
      if (extra.has(doc)) continue;
      extra.add(doc);
      stops.push(doc.watch(() => otherChanged(doc)));
    }
  };

  addDocuments(documents);

  const session = restoreSession ? restoreBrowserSession(store) : null;

  check(store.getState(), true);

  // A session saved with profiles, or before its spaces were isolated, is written once in its current shape.
  if (session?.spaces && sessionNeedsRewrite(session, store)) {
    dirty.add(DOCS.find((doc) => doc.name === "session.json")!);

    void save().catch((error) => console.warn("Couldn't save the session", error));
  }

  const unsubscribe = store.subscribe((_state, previous) => {
    // Space/private-window cleanup can produce nested updates before this subscriber runs, so save the current
    // state rather than the outer event.
    const state = store.getState();

    check(state);

    if (state.windows !== previous.windows) forgetClosedIncognito(state, previous);
  });

  stops.push(unsubscribe);

  const owner: PersistenceOwner = {
    flush({ final = false } = {}) {
      if (disposed) return Promise.reject(new Error("Persistence owner is disposed"));

      if (final) {
        if (finalFlush) return finalFlush;
        // Capture before freezing. Window closure during the quit must not replace this snapshot while its
        // acknowledged writes are still in flight.
        const snapshot = (finalSnapshot ??= store.getState());

        frozen = true;

        try {
          finalFlush = save(true, snapshot);
        } catch (error) {
          finalFlush = Promise.reject(error);
        }

        const pending = finalFlush;

        void pending.catch(() => {
          // A failed quit can retry the same frozen snapshot. An older failure cannot clear a newer attempt.
          if (finalFlush === pending) finalFlush = null;
        });

        return pending;
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
      finalSnapshot = undefined;
      check(store.getState());

      void save().catch((error) => console.warn("Couldn't save the session", error));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      dirty.clear();
      dirtyOther.clear();
      lastSources.clear();
      lastJson.clear();
      finalFlush = null;
      finalSnapshot = undefined;

      for (const stop of stops.reverse()) {
        try {
          stop();
        } catch (error) {
          console.error("[runtime] persistence service cleanup failed", error);
        }
      }
    },
  };

  // A disposed owner is gone: the next owner for this store starts from the saved session again.
  const forget = () => {
    if (saved.get(store)?.owner === owner) saved.delete(store);
  };

  stops.push(forget);

  return { owner, stops, addDocuments, services: false };
}

/**
 * The saving for one store: the session and the downloads.
 *
 * The owner for a store is found, not made twice: there is one subscription and one writer for a session.
 */
export function createPersistence({
  store,
  restoreSession = true,
  documents = [],
}: {
  store: BrowserStore;
  restoreSession?: boolean;
  documents?: readonly SavedDocument[];
}): PersistenceOwner {
  const existing = saved.get(store);

  if (existing) {
    existing.addDocuments(documents);

    return existing.owner;
  }

  const created = createSaved({ store, restoreSession, documents });

  saved.set(store, created);

  return created.owner;
}

/**
 * The store's own services: the ones that read Chrome and keep the app's own documents.
 *
 * The history, the bookmarks and the profile cleanup are the Effect runtime's services (lib/historyService.ts and its
 * neighbours): it owns them and starts them, so the saving does not keep a second copy of them.
 */
function startStoreServices(store: BrowserStore): (() => void)[] {
  const stops: (() => void)[] = [];

  try {
    stops.push(createFaviconService(store).start());
  } catch (error) {
    for (const stop of stops.reverse()) stop();

    throw error;
  }

  return stops;
}

/**
 * The app's saving for one store: the session, the downloads, and the favicons the store's pages show.
 */
export function createBrowserPersistence({
  store,
  restoreSession = true,
  documents = [],
}: {
  store: BrowserStore;
  restoreSession?: boolean;
  documents?: readonly SavedDocument[];
}): PersistenceOwner {
  const owner = createPersistence({ store, restoreSession, documents });
  const record = saved.get(store)!;

  if (!record.services) {
    record.services = true;

    for (const stop of startStoreServices(store)) record.stops.push(stop);
  }

  return owner;
}

/** The saving the app's own store has, if it has one. */
const ownerOf = (store: BrowserStore) => saved.get(store)?.owner;

let defaultOwner: PersistenceOwner | null = null;
let stopDefault: (() => void) | null = null;

/** Writes every document that changed, now. The quit handshake needs it before the process goes. */
export function flushPersistence(options: { final?: boolean } = {}): Promise<void> {
  return (defaultOwner ?? ownerOf(useBrowser))?.flush(options) ?? Promise.resolve();
}

/** The quit was cancelled: saving goes on, starting with what changed meanwhile. */
export function resumePersistence(): void {
  (defaultOwner ?? ownerOf(useBrowser))?.resume();
}

/** Starts the app's saving: the saved session is loaded, and every change from now on is written. */
export function startPersistence({ documents = [] }: { documents?: readonly SavedDocument[] } = {}): () => void {
  stopDefault?.();

  const owner = createBrowserPersistence({ store: useBrowser, documents });

  defaultOwner = owner;

  const stop = () => {
    owner.dispose();

    if (defaultOwner === owner) defaultOwner = null;

    if (stopDefault === stop) stopDefault = null;
  };

  stopDefault = stop;

  return stop;
}
