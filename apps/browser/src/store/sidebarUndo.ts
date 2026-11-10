import type { StateCreator } from "zustand";
import * as v from "valibot";
import type { BrowserState } from "./browserStore";
import { IDLE_LIVE, isIncognitoSpace, newId, pinnedPage, tabListKey, tabToShow } from "./model";
import { prunePinnedFolders } from "./folders";
import { sanitizeSplits } from "./splits";
import { activated } from "./tabs";
import { orderSections, placeBlock, syncGroupOrder } from "./groups";
import type { Tab } from "./types";

type RecordKey = "tabs" | "tabLists" | "groups" | "pinnedFolders" | "spaces" | "splits" | "localFiles";

type FieldValue = string | number | boolean | null | undefined | FieldValue[] | { [key: string]: FieldValue };

type SidebarActionArgs = FieldValue[];

type SidebarActionResult = FieldValue;

type SidebarAction = (...args: SidebarActionArgs) => SidebarActionResult;

interface FieldRecord {
  [id: string]: FieldValue;
}

const isRecordLike = (value: FieldValue): value is FieldRecord => value !== null && value !== undefined && v.is(v.object({}), value) && !Array.isArray(value);

type Change = { key: RecordKey; id: string; before: FieldValue; after: FieldValue };

export type SidebarEdit = {
  id?: string;
  changes: Change[];
  closedIds: string[];
  cleanedIds: string[];
  groupIds: string[];
  active?: { windowId: string; spaceId: string; before: string | undefined; after: string | undefined }[];
  undo?: boolean;
  /** For an `undo` entry: JSON data a registered handler reverses, so the entry survives recovery. */
  action?: SidebarUndoAction;
  folderOrder?: { before: string[]; after: string[] };
};

export type SidebarUndoAction = { kind: string; data: unknown };

export type SidebarUndoSlice = {
  sidebarUndo: Record<string, SidebarEdit[]>;
  undoSidebarEdit(windowId: string): boolean;
  pushSidebarUndo(windowId: string, action: SidebarUndoAction): void;
};

const RECORDS: RecordKey[] = ["tabs", "tabLists", "groups", "pinnedFolders", "spaces", "splits", "localFiles"];
const MAX_EDITS = 50;
// Edits outside BrowserState (Live folders) register how to reverse their JSON actions.
const handlers = new Map<string, (data: unknown) => void>();
export function registerSidebarUndo(kind: string, handler: (data: unknown) => void) {
  handlers.set(kind, handler);
}
let suspended = 0;
let originWindow: string | undefined;
export const sidebarUndoWindow = () => originWindow;

export function withSidebarUndoWindow<T>(windowId: string | undefined, action: () => T): T {
  const previous = originWindow;
  originWindow = windowId ?? previous;

  try {
    return action();
  } finally {
    originWindow = previous;
  }
}

export function withoutSidebarUndo<T>(action: () => T): T {
  suspended++;

  try {
    return action();
  } finally {
    suspended--;
  }
}

const same = (a: FieldValue, b: FieldValue) => a === b || JSON.stringify(a) === JSON.stringify(b);
const runtimeTabKeys = new Set(["navigation", "adoptId", "wakeAdoptId", "lastActiveAt"]);

// Loading or focusing a newly added saved row does not make it a different sidebar item.
// Preserve it if a later edit changed its placement, saved address, name, or icon.
function sameCreatedTab(current: FieldValue, after: FieldValue): boolean {
  // SAFETY: after is a Tab-shaped sidebar value here, so viewing it as Tab preserves its pinnedRow and folderId.
  if (!current || !(after as Tab | undefined)?.pinnedRow || !(after as Tab).folderId) return false;
  const keys: (keyof Tab)[] = ["id", "createdAt", "spaceId", "pinned", "pinnedRow", "folderId", "pinnedUrl", "customTitle", "customIcon", "kept"];

  // SAFETY: current and after are Tab-shaped sidebar values here, so viewing them as Tab preserves the listed keys.
  return keys.every((key) => same((current as Tab)[key], (after as Tab)[key]));
}

function changesBetween(before: BrowserState, after: BrowserState): Change[] {
  const changes: Change[] = [];

  for (const key of RECORDS) {
    if (before[key] === after[key]) continue;
    // SAFETY: key names a BrowserState record whose entries are JSON-shaped, so viewing it as FieldRecord preserves each entry value.
    const was = before[key] as FieldRecord;
    // SAFETY: key names a BrowserState record whose entries are JSON-shaped, so viewing it as FieldRecord preserves each entry value.
    const now = after[key] as FieldRecord;

    for (const id of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!same(was[id], now[id])) changes.push({ key, id, before: was[id], after: now[id] });
    }
  }

  return changes;
}

// Reverse only the fields this edit changed, provided another edit has not replaced their value since.
function reverseFields(current: FieldValue, before: FieldValue, after: FieldValue, key: RecordKey): FieldValue {
  if (key === "tabs" && before === undefined && sameCreatedTab(current, after)) return undefined;

  if (before === undefined || after === undefined || !isRecordLike(before) || !isRecordLike(after) || !isRecordLike(current)) {
    return same(current, after) ? before : current;
  }

  const result: FieldRecord = { ...current };

  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const wasValue = before[field];
    const nowValue = after[field];

    if (key === "tabs" && runtimeTabKeys.has(field)) continue;

    if (same(wasValue, nowValue) || !same(result[field], nowValue)) continue;

    if (wasValue === undefined) delete result[field];
    else result[field] = wasValue;
  }

  return result;
}

// New tabs opened after the edit stay in the list. A later reorder of the same rows wins over old undo.
function reverseOrder(current: string[], before: string[], after: string[], belongs: (id: string) => boolean): string[] {
  const known = new Set([...before, ...after]);
  const out = current.filter(belongs);
  const prior = before.filter(belongs);
  const comparable = out.filter((id) => known.has(id));
  const expected = after.filter((id) => out.includes(id));

  // Restore an old reorder only if those rows have not been reordered again in another window.
  if (same(comparable, expected)) {
    const reordered = prior.filter((id) => out.includes(id));
    const slots = new Set(reordered);
    let index = 0;

    for (let i = 0; i < out.length; i++) if (slots.has(out[i]!)) out[i] = reordered[index++]!;
  }

  // A later reorder never prevents closed rows from returning to a list.
  for (const id of prior) {
    if (out.includes(id)) continue;
    const at = prior.indexOf(id);
    const next = prior.slice(at + 1).find((t) => out.includes(t));

    const prev = prior
      .slice(0, at)
      .reverse()
      .find((t) => out.includes(t));

    out.splice(next ? out.indexOf(next) : prev ? out.indexOf(prev) + 1 : 0, 0, id);
  }

  return out;
}

export const createSidebarUndoSlice: StateCreator<BrowserState, [], [], SidebarUndoSlice> = (set, get) => ({
  sidebarUndo: {},
  pushSidebarUndo(windowId, action) {
    const s = get();

    if (suspended || !s.windows[windowId]) return;
    const edit: SidebarEdit = {
      id: newId("undo"),
      changes: [],
      closedIds: [],
      cleanedIds: [],
      groupIds: [],
      undo: true,
      action: JSON.parse(JSON.stringify(action)) as SidebarUndoAction,
    };
    set({ sidebarUndo: { ...s.sidebarUndo, [windowId]: [...(s.sidebarUndo[windowId] ?? []), edit].slice(-MAX_EDITS) } });
  },
  undoSidebarEdit(windowId) {
    const s = get();
    const stack = s.sidebarUndo[windowId];
    const edit = stack?.at(-1);

    if (!s.windows[windowId] || !edit) return false;
    const patch: Partial<BrowserState> = { sidebarUndo: { ...s.sidebarUndo, [windowId]: stack!.slice(0, -1) } };

    if (edit.undo) {
      const handler = edit.action && handlers.get(edit.action.kind);
      if (handler) withoutSidebarUndo(() => handler(edit.action!.data));
      set({ sidebarUndo: patch.sidebarUndo! });

      return true;
    }

    for (const key of RECORDS) {
      if (key === "tabLists") continue;
      // SAFETY: key names a BrowserState record whose entries are JSON-shaped, so viewing it as FieldRecord preserves each entry value.
      const map: FieldRecord = { ...(s[key] as Record<string, FieldValue>) };

      for (const change of edit.changes.filter((c) => c.key === key)) {
        // A deleted space is never recreated: its native profile may already have been removed.
        if (key === "spaces" && !map[change.id]) continue;
        let value = reverseFields(map[change.id], change.before, change.after, key);

        if (key === "tabs" && value) {
          // SAFETY: a tabs value restored here is Tab-shaped, so viewing it as Tab preserves its spaceId.
          const tab = value as Tab;
          const privateSpace = isIncognitoSpace(tab.spaceId) && Object.values(s.windows).some((w) => w.incognito && w.spaceId === tab.spaceId);

          if (!s.spaces[tab.spaceId] && !privateSpace) continue;
        }

        if (key === "localFiles" && value) {
          // SAFETY: a localFiles value restored here is LocalFilePin-shaped, so viewing it as { spaceId } preserves its spaceId.
          const fileSpaceId = (value as { spaceId: string }).spaceId;

          if (!s.spaces[fileSpaceId]) continue;
        }

        // SAFETY: a tabs before value here is Tab-shaped, so viewing it as Tab preserves its navigation and adoptId.
        const beforeTab = change.before as Tab | undefined;
        // SAFETY: a tabs after value here is Tab-shaped, so viewing it as Tab preserves its unloaded flag.
        const afterTab = change.after as Tab | undefined;
        // SAFETY: the current map entry for a tabs change is Tab-shaped, so viewing it as Tab preserves its unloaded flag.
        const currentTab = map[change.id] as Tab | undefined;

        const unloadedClose = key === "tabs" && !!(beforeTab?.navigation || beforeTab?.adoptId) && afterTab?.unloaded && currentTab?.unloaded;

        if (key === "tabs" && value && (!map[change.id] || unloadedClose)) {
          // SAFETY: a tabs value restored here is Tab-shaped, so viewing it as Tab preserves its window and flags.
          const tab = value as Tab;

          if (!s.spaces[tab.spaceId] && !s.windows[windowId]!.incognito) continue;
          value = {
            ...tab,
            windowId: s.windows[tab.windowId] ? tab.windowId : windowId,
            navigation: null,
            adoptId: undefined,
            wakeAdoptId: `restore:${tab.id}`,
            unloaded: true,
          };
        }

        if (value === undefined) delete map[change.id];
        else map[change.id] = value;
      }

      Object.assign(patch, { [key]: map });
    }

    let next = prunePinnedFolders({ ...s, ...patch });

    if (edit.folderOrder) {
      const order = reverseOrder(Object.keys(s.pinnedFolders), edit.folderOrder.before, edit.folderOrder.after, (id) => !!next.pinnedFolders[id]);
      next.pinnedFolders = Object.fromEntries(order.map((id) => [id, next.pinnedFolders[id]!]));
    }

    // A newer group assignment wins when a close undo recreates an older group.
    const owners = new Map<string, string>();

    for (const g of Object.values(s.groups)) for (const id of g.tabIds) if (next.groups[g.id]?.tabIds.includes(id)) owners.set(id, g.id);
    const reconciled: BrowserState["groups"] = {};

    for (const g of Object.values(next.groups)) {
      const tabIds = g.tabIds.filter(
        (id) => next.tabs[id]?.spaceId === g.spaceId && !pinnedPage(next.tabs[id]!) && (!owners.has(id) || owners.get(id) === g.id),
      );

      if (!tabIds.length || (g.autoUngroup && tabIds.length < 2)) continue;

      for (const id of tabIds) owners.set(id, g.id);
      reconciled[g.id] = { ...g, tabIds };
    }

    next.groups = reconciled;
    const tabLists = { ...s.tabLists };

    for (const c of edit.changes.filter((c) => c.key === "tabLists")) {
      // SAFETY: a tabLists before value here is a tab-id list, so viewing it as string[] preserves the order.
      const beforeIds = (c.before as string[] | undefined) ?? [];
      // SAFETY: a tabLists after value here is a tab-id list, so viewing it as string[] preserves the order.
      const afterIds = (c.after as string[] | undefined) ?? [];
      tabLists[c.id] = reverseOrder(tabLists[c.id] ?? [], beforeIds, afterIds, (id) => !!next.tabs[id] && tabListKey(next, next.tabs[id]!) === c.id);
    }

    for (const [key, ids] of Object.entries(tabLists)) {
      let ordered = ids.filter((id) => next.tabs[id] && tabListKey(next, next.tabs[id]!) === key);

      for (const g of Object.values(next.groups)) {
        const members = ordered.filter((id) => g.tabIds.includes(id));

        if (members.length) ordered = placeBlock(ordered, members);
      }

      ordered = orderSections(ordered, next.tabs, next.groups, next.pinnedFolders);
      tabLists[key] = ordered;
      next.groups = syncGroupOrder(next.groups, { key, tabIds: ordered });
    }

    const live = { ...s.live };

    for (const id of Object.keys(next.tabs)) if (!live[id]) live[id] = IDLE_LIVE;

    for (const id of Object.keys(live)) if (!next.tabs[id]) delete live[id];
    const closed = new Set(edit.closedIds);
    const cleaned = new Set(edit.cleanedIds);
    const groups = new Set(edit.groupIds);
    next = {
      ...next,
      tabLists,
      live,
      splits: sanitizeSplits(next.splits, next.tabs),
      closedTabs: s.closedTabs.filter((c) => !closed.has(c.id)),
      cleanedTabs: s.cleanedTabs.filter((c) => !cleaned.has(c.id)),
      privateCleanedTabs: Object.fromEntries(Object.entries(s.privateCleanedTabs).map(([id, entries]) => [id, entries.filter((c) => !cleaned.has(c.id))])),
      closedGroups: s.closedGroups.filter((c) => !groups.has(c.id)),
      deletedGroups: s.deletedGroups.filter((c) => !groups.has(c.id)),
    };

    for (const active of edit.active ?? []) {
      const window = next.windows[active.windowId];

      if (!window || window.activeTabIds[active.spaceId] !== active.after || !active.before || !next.tabs[active.before]) continue;

      if (window.spaceId === active.spaceId) next = { ...next, ...activated(next, active.before, active.windowId) };
      else next.windows = { ...next.windows, [window.id]: { ...window, activeTabIds: { ...window.activeTabIds, [active.spaceId]: active.before } } };
    }

    for (const window of Object.values(next.windows)) {
      const activeTabIds = Object.fromEntries(Object.entries(window.activeTabIds).filter(([, id]) => !!next.tabs[id]));
      const current = { ...window, activeTabIds };
      next.windows = { ...next.windows, [window.id]: current };

      if (!activeTabIds[window.spaceId]) {
        const shown = tabToShow(next, window.id, window.spaceId);

        if (shown) next = { ...next, ...activated(next, shown, window.id) };
      }
    }

    set(next);

    return true;
  },
});

const EDIT_ACTIONS = new Set([
  "closeTab",
  "closeTabs",
  "removeTab",
  "moveTab",
  "moveTabToSpace",
  "moveTabsToWindow",
  "placeTabs",
  "pinTabs",
  "pinRows",
  "togglePin",
  "updateTab",
  "updateSpace",
  "updateGroup",
  "updatePinnedFolder",
  "movePinnedFolder",
  "newPinnedFolder",
  "importSharedCollection",
  "deletePinnedFolder",
  "createGroup",
  "groupTabs",
  "moveGroup",
  "ungroup",
  "closeGroup",
  "deleteGroup",
  "addTabsToGroup",
  "removeTabsFromGroup",
  "setPinnedUrl",
  "cleanUpTabs",
  "tidyTabs",
  "createSplit",
  "separateSplit",
  "removeTabFromSplit",
  "pinLocalFiles",
  "removeLocalFile",
  "renameLocalFile",
  "moveLocalFile",
]);

function editWindow(s: BrowserState, action: string, args: SidebarActionArgs): string | undefined {
  if (originWindow && s.windows[originWindow]) return originWindow;

  if (action === "cleanUpTabs" || action === "tidyTabs" || action === "newPinnedFolder" || action === "pinLocalFiles" || action === "importSharedCollection")
    // SAFETY: these actions take a windowId string as their first argument, so args[0] is that string.
    return args[0] as string;
  const focused = s.ui.focusedWindowId;

  if (focused && s.windows[focused]) return focused;
  // SAFETY: editWindow actions take a tab or window id, a list of them, or a target object as first argument, but callers pass a string or string list here.
  const id = (Array.isArray(args[0]) ? args[0][0] : args[0]) as string;
  const tab = s.tabs[id];

  if (tab && s.windows[tab.windowId]) return tab.windowId;
  const space = tab?.spaceId ?? s.pinnedFolders[id]?.spaceId ?? s.groups[id]?.spaceId ?? s.localFiles[id]?.spaceId ?? (s.spaces[id] ? id : undefined);

  return s.windowOrder.find((w) => s.windows[w]?.spaceId === space);
}

/** One transaction even when one sidebar action calls another. Engine reports are deliberately excluded. */
export function withSidebarUndoActions(state: BrowserState, get: () => BrowserState, set: (patch: Partial<BrowserState>) => void): BrowserState {
  let depth = 0;
  const automaticCleanup = state.cleanUpInactiveTabs;
  state.cleanUpInactiveTabs = () => withoutSidebarUndo(automaticCleanup);

  for (const action of EDIT_ACTIONS) {
    // SAFETY: action names a BrowserState slice method, so the indexed value is that method or undefined.
    const original = state[action as keyof BrowserState];

    if (!v.is(v.function_(), original)) continue;

    const wrapped = (...args: SidebarActionArgs) => {
      // SAFETY: updateTab takes a tab patch object as its second argument, so viewing it as a string record preserves its keys.
      const patchRecord = (args[1] ?? {}) as Record<string, FieldValue>;

      if (
        suspended ||
        depth ||
        (action === "updateTab" && !Object.keys(patchRecord).some((key) => ["customTitle", "customIcon", "pinnedUrl", "kept"].includes(key)))
      )
        // SAFETY: original is a BrowserState slice method checked above, so viewing it as SidebarAction preserves its call shape.
        return (original as SidebarAction)(...args);
      const before = get();
      const windowId = editWindow(before, action, args);
      depth++;
      let result: SidebarActionResult;

      try {
        // SAFETY: original is a BrowserState slice method checked above, so viewing it as SidebarAction preserves its call shape.
        result = (original as SidebarAction)(...args);
      } finally {
        depth--;
      }

      const after = get();

      if (!windowId || !after.windows[windowId]) return result;
      const changes = changesBetween(before, after);
      const beforeFolders = Object.keys(before.pinnedFolders);
      const afterFolders = Object.keys(after.pinnedFolders);
      const folderOrder = same(beforeFolders, afterFolders) ? undefined : { before: beforeFolders, after: afterFolders };

      if (!changes.length && !folderOrder) return result;

      const added = (was: { id: string }[], now: { id: string }[]): string[] => {
        const out: string[] = [];

        for (const c of now) if (!was.some((p) => p.id === c.id)) out.push(c.id);

        return out;
      };

      const active: NonNullable<SidebarEdit["active"]> = [];

      for (const window of Object.values(before.windows)) {
        const now = after.windows[window.id];

        if (!now) continue;

        for (const spaceId of new Set([...Object.keys(window.activeTabIds), ...Object.keys(now.activeTabIds)])) {
          const previousActive = window.activeTabIds[spaceId],
            afterActive = now.activeTabIds[spaceId];

          if (previousActive !== afterActive) active.push({ windowId: window.id, spaceId, before: previousActive, after: afterActive });
        }
      }

      const edit: SidebarEdit = {
        id: newId("undo"),
        changes,
        folderOrder,
        active,
        closedIds: added(before.closedTabs, after.closedTabs),
        cleanedIds: added(
          [...before.cleanedTabs, ...Object.values(before.privateCleanedTabs).flat()],
          [...after.cleanedTabs, ...Object.values(after.privateCleanedTabs).flat()],
        ),
        groupIds: added([...before.closedGroups, ...before.deletedGroups], [...after.closedGroups, ...after.deletedGroups]),
      };

      set({ sidebarUndo: { ...after.sidebarUndo, [windowId]: [...(after.sidebarUndo[windowId] ?? []), edit].slice(-MAX_EDITS) } });

      return result;
    };

    Object.assign(state, { [action]: wrapped });
  }

  return state;
}
