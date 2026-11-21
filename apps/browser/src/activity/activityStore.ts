import { readDocument, saveDocument, writeDocument } from "@bay/desktop";
import { create } from "zustand";
import { sendService } from "../runtime/serviceClient";
import { useBrowser, type BrowserStore } from "../store/browserStore";
import { registerSidebarUndo, sidebarUndoWindow } from "../store/sidebarUndo";
import type { CompletedItem, CompletionState, FolderStatus, LiveAccount, LiveFolder, LiveFolderKind, LiveItem, LiveSourceId } from "./types";
import type { SavedDocument } from "../lib/savedDocument";
import { LIVE_DOC, MAX_COMPLETED_ITEMS, MAX_KNOWN_ITEMS } from "./constants";

export type LiveConfig = {
  githubClientId: string;
  bitbucketUser: string;
  confluenceSite: string;
  confluenceEmail: string;
  googleClientId: string;
};

export type CalendarSettings = {
  alertLead: string;
  alertCondition: "always" | "activeOnly";
  showPreview: boolean;
  showTimeToNext: boolean;
  hiddenCalendarIds: string[];
  prompted: boolean;
};

export type MeetingGroup = {
  groupId: string;
  callTabId: string;
  occurrence: string | null;
  title: string;
  start: number | null;
  end: number | null;
  endedAt: number | null;
};

export type LiveState = {
  folders: Record<string, LiveFolder>;
  folderOrder: string[];
  items: Record<string, LiveItem[]>;
  known: Record<string, string[]>;
  unread: Record<string, string[]>;
  completed: Record<string, CompletedItem[]>;
  completing: Record<string, string[]>;
  status: Record<string, FolderStatus>;
  expandedStacks: Record<string, boolean>;
  showAll: Record<string, boolean>;
  accounts: Partial<Record<LiveSourceId, LiveAccount>>;
  config: LiveConfig;
  calendar: CalendarSettings;
  meetingGroups: Record<string, MeetingGroup>;
  dismissedAlerts: string[];
};

export const DEFAULT_CONFIG: LiveConfig = { githubClientId: "", bitbucketUser: "", confluenceSite: "", confluenceEmail: "", googleClientId: "" };

export const DEFAULT_CALENDAR: CalendarSettings = {
  alertLead: "1",
  alertCondition: "always",
  showPreview: true,
  showTimeToNext: true,
  hiddenCalendarIds: [],
  prompted: false,
};

const PERSISTED = [
  "folders",
  "folderOrder",
  "items",
  "known",
  "unread",
  "completed",
  "expandedStacks",
  "accounts",
  "config",
  "calendar",
  "meetingGroups",
  "dismissedAlerts",
] as const;

function load(): Partial<LiveState> {
  try {
    const json = readDocument(LIVE_DOC);

    // SAFETY: the live document is only ever written by this store, so it holds a serialized `LiveState`.
    return json ? (JSON.parse(json) as Partial<LiveState>) : {};
  } catch {
    return {};
  }
}

const initialState = (saved: Partial<LiveState> = {}): LiveState => ({
  folders: saved.folders ?? {},
  folderOrder: saved.folderOrder ?? [],
  items: saved.items ?? {},
  known: saved.known ?? {},
  unread: saved.unread ?? {},
  completed: saved.completed ?? {},
  completing: {},
  status: {},
  expandedStacks: saved.expandedStacks ?? {},
  showAll: {},
  accounts: saved.accounts ?? {},
  config: { ...DEFAULT_CONFIG, ...saved.config },
  calendar: { ...DEFAULT_CALENDAR, ...saved.calendar },
  meetingGroups: saved.meetingGroups ?? {},
  dismissedAlerts: saved.dismissedAlerts ?? [],
});

// Importing window UI creates an in-memory view, without reading shared files
// or installing another document writer. The application owner starts IO.
export const useLive = create<LiveState>()(() => initialState());

export const live = () => useLive.getState();
export const setLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => useLive.setState(patch);

/**
 * The store the live folders belong to.
 *
 * The live state is the app's, not the coordinator's: a window reads it and the coordinator owns it. This says which
 * store writes it, so the coordinator's authority store is the one that is saved.
 */
let browserOwner: BrowserStore = useBrowser;

/** Binds the live folders to a store, and gives back the unbind. */
export function bindLiveStoreBrowser(browser: BrowserStore): () => void {
  const previous = browserOwner;
  browserOwner = browser;

  return () => {
    if (browserOwner === browser) browserOwner = previous;
  };
}

/**
 * The live folders' own saving.
 *
 * The folders are the app's, not the coordinator's: a window reads them and the coordinator owns them. This is the
 * owner of their document, so a change is written with the session's own and the quit saves them too.
 */
type LivePersistence = { stop(): void; flush(final: boolean): Promise<void>; resume(): void };

let persistence: LivePersistence | undefined;

/** Writes the live folders' document now. */
export function flushLivePersistence({ final = false } = {}): Promise<void> {
  return persistence?.flush(final) ?? Promise.resolve();
}

/** A quit was cancelled: the saving goes on, starting with what changed meanwhile. */
export function resumeLivePersistence() {
  persistence?.resume();
}

/** Owns the live folders' saving, and gives back its stop. */
export function startLivePersistence(): () => void {
  if (persistence) return persistence.stop;
  useLive.setState(initialState(load()), true);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let frozen = false;
  let finalFlush: Promise<void> | null = null;

  const json = () => {
    const state = live();

    return JSON.stringify(Object.fromEntries(PERSISTED.map((key) => [key, state[key]])));
  };

  const write = () => {
    timer = undefined;

    try {
      writeDocument(LIVE_DOC, json());
    } catch (error) {
      console.warn("Couldn't save live folders", error);
    }
  };

  const save = (): Promise<void> => {
    try {
      return Promise.resolve(saveDocument(LIVE_DOC, json()));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const unsubscribe = useLive.subscribe((s, prev) => {
    if (frozen || PERSISTED.every((key) => s[key] === prev[key])) return;
    clearTimeout(timer);
    timer = setTimeout(write, 800);
  });

  const stop = () => {
    if (persistence?.stop !== stop) return;
    clearTimeout(timer);
    unsubscribe();
    persistence = undefined;
  };

  persistence = {
    stop,
    flush(final) {
      clearTimeout(timer);
      timer = undefined;

      if (frozen) return finalFlush ?? Promise.resolve();

      if (!final) return save();
      // Capture and acknowledge every final document, including a pending
      // background write. Closing-window mutations must not replace it.
      frozen = true;
      finalFlush = save();

      return finalFlush;
    },
    resume() {
      frozen = false;
      finalFlush = null;
      clearTimeout(timer);
      // Cancellation preserves changes made while closing, without loading
      // disk state over the current in-memory folders and account settings.
      write();
    },
  };

  return stop;
}

/**
 * The live folders' document, as the app's saving keeps it (lib/persistenceService.ts): a change is written with the
 * session's own, so a burst of them is one write, a write that fails is tried again, and the quit saves it too.
 */
export const liveFoldersDocument: SavedDocument = {
  name: LIVE_DOC,
  json: () => {
    const s = live();

    return JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, s[k]])));
  },
  watch: (changed) =>
    useLive.subscribe((s, prev) => {
      if (!PERSISTED.every((k) => s[k] === prev[k])) changed();
    }),
};

type LiveFolderUndo = { id: string; before: Partial<LiveFolder>; after: Partial<LiveFolder> };

// Restores only the fields a later edit has not changed again.
registerSidebarUndo("liveFolder", (value) => {
  // SAFETY: the checks above established this shape.
  const { id, before, after } = value as LiveFolderUndo;
  const current = useLive.getState().folders[id];

  if (!current) return;
  const restore: Partial<LiveFolder> = {};

  for (const key of ["name", "icon"] as const) if (key in before && (current[key] ?? null) === after[key]) Object.assign(restore, { [key]: before[key] });
  setLive({ folders: { ...useLive.getState().folders, [id]: { ...current, ...restore } } });
});

let counter = 0;
const newId = () => `lf-${Date.now().toString(36)}-${(++counter).toString(36)}`;

export const FOLDER_DEFAULTS: Record<LiveFolderKind, { name: string; sources: LiveSourceId[] }> = {
  pullRequests: { name: "Pull Requests", sources: ["github"] },
  documents: { name: "Documents", sources: ["notion"] },
};

export function createFolder(spaceId: string, kind: LiveFolderKind, sources?: LiveSourceId[]): string {
  const id = newId();

  const folder: LiveFolder = {
    id,
    spaceId,
    kind,
    name: FOLDER_DEFAULTS[kind].name,
    icon: null,
    collapsed: false,
    sources: sources ?? FOLDER_DEFAULTS[kind].sources,
    filters: { authored: true, reviewRequests: true },
    createdAt: Date.now(),
  };

  setLive((s) => ({
    folders: { ...s.folders, [id]: folder },
    folderOrder: [...s.folderOrder, id],
    status: { ...s.status, [id]: { state: "initializing", lastFetch: null, error: null } },
  }));

  return id;
}

export function updateFolder(id: string, patch: Partial<Omit<LiveFolder, "id" | "spaceId" | "kind">>, originWindowId?: string) {
  if (sendService("liveUpdate", [id, patch])) return;
  const before = useLive.getState().folders[id];
  setLive((s) => (s.folders[id] ? { folders: { ...s.folders, [id]: { ...s.folders[id]!, ...patch } } } : {}));
  const fields = (["name", "icon"] as const).filter((key) => before && patch[key] !== undefined && before[key] !== patch[key]);
  const windowId = originWindowId ?? sidebarUndoWindow() ?? browserOwner.getState().ui.focusedWindowId;

  if (before && windowId && fields.length) {
    const pick = (folder: Partial<LiveFolder>) => Object.fromEntries(fields.map((key) => [key, folder[key] ?? null]));
    const data: LiveFolderUndo = { id, before: pick(before), after: pick(patch) };
    browserOwner.getState().pushSidebarUndo(windowId, { kind: "liveFolder", data });
  }
}

/** Marks an item unread in a folder. */
export function markUnread(folderId: string, itemId: string) {
  if (sendService("liveUnread", [folderId, itemId])) return;
  setLive((s) => ({ unread: { ...s.unread, [folderId]: [...new Set([...(s.unread[folderId] ?? []), itemId])] } }));
}

/** Sets one of the live view's own flags: a stack's expansion, or the show-all switch. */
export function setLiveView(field: "expandedStacks" | "showAll", key: string, value: boolean) {
  if (sendService("liveView", [field, key, value])) return;
  setLive((s) => ({ [field]: { ...s[field], [key]: value } }));
}

const without = <T>(record: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = record;

  return rest;
};

export function removeFolder(id: string) {
  if (sendService("liveRemove", [id])) return;
  setLive((s) => ({
    folders: without(s.folders, id),
    folderOrder: s.folderOrder.filter((f) => f !== id),
    items: without(s.items, id),
    known: without(s.known, id),
    unread: without(s.unread, id),
    completed: without(s.completed, id),
    completing: without(s.completing, id),
    status: without(s.status, id),
  }));
}

export function moveFolder(id: string, delta: -1 | 1) {
  if (sendService("liveMove", [id, delta])) return;
  setLive((s) => {
    const order = [...s.folderOrder];
    const i = order.indexOf(id);
    const j = i + delta;

    if (i < 0 || j < 0 || j >= order.length) return {};
    [order[i], order[j]] = [order[j]!, order[i]!];

    return { folderOrder: order };
  });
}

export function applyFetch(folderId: string, next: LiveItem[], gone: Record<string, CompletionState>, now = Date.now(), quiet: Set<string> = new Set()) {
  setLive((s) => {
    if (!s.folders[folderId]) return {};
    const known = new Set(s.known[folderId] ?? []);
    const first = known.size === 0 && !s.status[folderId]?.lastFetch;
    const fresh = next.flatMap((it) => (known.has(it.id) ? [] : [it.id]));
    const unreadFresh = fresh.filter((id) => !quiet.has(id));
    const ids = new Set(next.map((it) => it.id));
    const prev = s.items[folderId] ?? [];
    const animating = new Set(s.completing[folderId] ?? []);
    const leaving = prev.filter((it) => !ids.has(it.id) && gone[it.id] && !animating.has(it.id));
    const merged = [...next];

    for (const it of prev)
      if (!ids.has(it.id) && (animating.has(it.id) || leaving.includes(it))) merged.splice(Math.min(prev.indexOf(it), merged.length), 0, it);

    const completed = [
      ...leaving.map((item) => ({ item, state: gone[item.id]!, at: now })),
      ...(s.completed[folderId] ?? []).filter((c) => !ids.has(c.item.id) && !leaving.some((l) => l.id === c.item.id)),
    ].slice(0, MAX_COMPLETED_ITEMS);

    const stillThere = new Set(merged.map((it) => it.id));

    return {
      items: { ...s.items, [folderId]: merged },
      known: { ...s.known, [folderId]: [...known, ...fresh].slice(-MAX_KNOWN_ITEMS) },
      unread: { ...s.unread, [folderId]: first ? [] : [...new Set([...(s.unread[folderId] ?? []), ...unreadFresh])].filter((id) => stillThere.has(id)) },
      completed: leaving.length || (s.completed[folderId] ?? []).length !== completed.length ? { ...s.completed, [folderId]: completed } : s.completed,
      completing: leaving.length ? { ...s.completing, [folderId]: [...(s.completing[folderId] ?? []), ...leaving.map((l) => l.id)] } : s.completing,
      status: { ...s.status, [folderId]: { state: "idle", lastFetch: now, error: null } },
    };
  });
}

export function finishCompleting(folderId: string, ids: string[]) {
  setLive((s) => ({
    items: { ...s.items, [folderId]: (s.items[folderId] ?? []).filter((it) => !ids.includes(it.id)) },
    completing: { ...s.completing, [folderId]: (s.completing[folderId] ?? []).filter((id) => !ids.includes(id)) },
    unread: { ...s.unread, [folderId]: (s.unread[folderId] ?? []).filter((id) => !ids.includes(id)) },
  }));
}

export function setStatus(folderId: string, status: Partial<FolderStatus>) {
  setLive((s) => {
    const current = s.status[folderId] ?? { state: "idle" as const, lastFetch: null, error: null };

    return { status: { ...s.status, [folderId]: { ...current, ...status } } };
  });
}

export function markRead(folderId: string, itemIds?: string[]) {
  if (sendService("liveRead", [folderId, itemIds ?? null])) return;
  setLive((s) => {
    const unread = s.unread[folderId] ?? [];
    const next = itemIds ? unread.filter((id) => !itemIds.includes(id)) : [];

    return next.length === unread.length ? {} : { unread: { ...s.unread, [folderId]: next } };
  });
}

export function setAccount(source: LiveSourceId, account: LiveAccount | null) {
  setLive((s) => {
    const accounts = { ...s.accounts };

    if (account) accounts[source] = account;
    else delete accounts[source];

    return { accounts };
  });
}

export const updateConfig = (patch: Partial<LiveConfig>) => {
  if (sendService("liveConfig", [patch])) return;
  setLive((s) => ({ config: { ...s.config, ...patch } }));
};

export const updateCalendarSettings = (patch: Partial<CalendarSettings>) => {
  if (sendService("calendarSettings", [patch])) return;
  setLive((s) => ({ calendar: { ...s.calendar, ...patch } }));
};

export function dismissAlert(occurrence: string) {
  if (sendService("alertDismiss", [occurrence])) return;
  setLive((s) => (s.dismissedAlerts.includes(occurrence) ? {} : { dismissedAlerts: [...s.dismissedAlerts, occurrence].slice(-200) }));
}

export function setMeetingGroup(group: MeetingGroup | null, groupId?: string) {
  setLive((s) => {
    if (group) return { meetingGroups: { ...s.meetingGroups, [group.groupId]: group } };

    return groupId && s.meetingGroups[groupId] ? { meetingGroups: without(s.meetingGroups, groupId) } : {};
  });
}

export const profileFolders = (s: LiveState, spaceId: string) => s.folderOrder.filter((id) => s.folders[id]?.spaceId === spaceId);
