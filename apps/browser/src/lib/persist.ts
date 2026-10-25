import { cancelDownload, type Download } from "@bay/nncore";
import { readDocument, writeDocument } from "@bay/shell";
import { useBrowser, type BrowserState, type HydrateData } from "../store/browser";
import { inPinnedContainer, isIncognitoSpace, newId, snapshotTab } from "../store/model";
import type { BrowserWindow, ClosedTab, Tab } from "../store/types";
import { isolateSavedSpaces } from "../store/spaces";
import { normalizeLocalFiles } from "../store/localFiles";
import { startLibrary } from "../components/library/state";
import { startFavicons } from "./favicons";
import { startBookmarks } from "./bookmarks";
import { startHistory } from "./history";
import { startProfileDataCleanup } from "./profileData";
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
    json: serialized((s) => {
      // Private windows, Little Bay and peeks aren't restored: closing (or quitting) throws their pages away.
      const windows = Object.values(s.windows).filter((w) => !w.incognito && w.kind !== "small");
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
        localFiles: Object.values(normalizeLocalFiles(s.localFiles, s.spaces)),
        splits: Object.values(s.splits).filter((v) => v.tabIds.every((id) => saved.has(id))),
        // The store keeps private windows out of these lists; filter again so nothing private is ever written.
        closedTabs: s.closedTabs.filter((c) => publicTab(c.tab)),
        closedWindows: s.closedWindows.filter((c) => c.tabs.every(publicTab)),
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
  profiles?: HydrateData["spaces"];
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
  splits: BrowserState["splits"][string][];
  closedTabs: ClosedTab[];
  closedWindows: BrowserState["closedWindows"];
  closedGroups?: BrowserState["closedGroups"];
  deletedGroups?: BrowserState["deletedGroups"];
  cleanedTabs?: BrowserState["cleanedTabs"];
};

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
  const session = read<SessionV2>("session.json");
  if (session?.version !== 2) return null;
  const spaces = session.spaces ?? session.profiles;
  const spaceOrder = session.spaceOrder ?? session.profileOrder ?? [];
  if (spaces) {
    const order = [...new Set([...spaceOrder.filter((id) => spaces[id]), ...Object.keys(spaces)])];
    const { owners, detached } = isolateSavedSpaces(spaces, order, session.orphanedProfileData ?? []);
    if (detached.size || (!session.spaces && session.profiles)) backupBeforeIsolation("session.json");
    if (detached.size) isolateLegacyFiles(owners, detached);
  }
  const downloads = read<{ downloads: Download[] }>("downloads.json");
  const data: HydrateData = {
    spaces,
    spaceOrder,
    orphanedProfileData: session.orphanedProfileData ?? [],
    settings: session.settings,
    windows: byId(session.windows),
    windowOrder: session.windowOrder,
    focusedWindowId: session.focusedWindowId,
    tabs: byId(session.tabs),
    tabLists: session.tabLists ?? {},
    groups: byId(session.groups),
    pinnedFolders: byId(session.pinnedFolders),
    localFiles: normalizeLocalFiles({ ...session.localFiles }, spaces),
    splits: byId(session.splits),
    closedTabs: session.closedTabs,
    closedWindows: session.closedWindows,
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
            window: { spaceId, sidebarOpen: w?.sidebarOpen ?? true, frame: w?.frame ?? null },
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

let flush: () => void = () => {};
let resume: () => void = () => {};
// From the quit's last save until the quit ends or is cancelled: what the quit itself does to the store (its windows
// closing) is never saved.
let frozen = false;

export function flushPersistence({ final = false } = {}) {
  flush();
  if (final) frozen = true;
}

// The quit was cancelled (a page's beforeunload said Stay): saving goes on, starting with what changed meanwhile.
export function resumePersistence() {
  frozen = false;
  resume();
}

export function startPersistence() {
  const session = loadSession();
  useBrowser.getState().hydrate(session ?? {});
  startLibrary();

  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frozen) return;
    const s = useBrowser.getState();
    for (const doc of DOCS.filter((d) => dirty.has(d))) {
      const json = doc.json(s);
      if (lastJson.get(doc.name) !== json) {
        lastJson.set(doc.name, json);
        write(doc.name, json);
      }
    }
    dirty.clear();
  };
  flush = save;

  const check = (s: BrowserState, initial = false) => {
    if (frozen) return;
    for (const doc of DOCS) {
      const sources = doc.sources(s);
      const prev = lastSources.get(doc.name);
      if (prev && sources.every((v, i) => v === prev[i])) continue;
      lastSources.set(doc.name, sources);
      if (!initial) dirty.add(doc);
    }
    if (dirty.size && !timer) timer = setTimeout(save, SAVE_DELAY_MS);
  };
  check(useBrowser.getState(), true);
  if (
    session?.spaces &&
    (!read<SessionV2>("session.json")?.spaces ||
      Object.entries(session.spaces).some(([id, space]) => space.profileId !== useBrowser.getState().spaces[id]?.profileId))
  ) {
    dirty.add(DOCS.find((doc) => doc.name === "session.json")!);
    save();
  }
  resume = () => {
    check(useBrowser.getState());
    save();
  };
  const stopFavicons = startFavicons();
  const stopHistory = startHistory();
  const stopBookmarks = startBookmarks();
  const stopProfileData = startProfileDataCleanup();
  const stopSession = useBrowser.subscribe((s, prev) => {
    check(s);
    if (s.windows !== prev.windows) forgetClosedIncognito(s, prev);
  });
  return () => {
    stopFavicons();
    stopHistory();
    stopBookmarks();
    stopProfileData();
    stopSession();
  };
}

function forgetClosedIncognito(s: BrowserState, prev: BrowserState) {
  for (const w of Object.values(prev.windows)) {
    if (!w.incognito || s.windows[w.id]) continue;
    for (const d of s.downloads) if (d.profile === w.spaceId && d.state === "downloading") void cancelDownload(d.id);
    s.forgetDownloads(w.spaceId);
  }
}
