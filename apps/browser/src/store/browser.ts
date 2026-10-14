import { create, type StateCreator } from "zustand";
import { createBookmarksSlice, EMPTY_BOOKMARKS, engineRoots, rootIdsFor, type BookmarksSlice } from "./bookmarks";
import { createFoldersSlice, prunePinnedFolders, type FoldersSlice } from "./folders";
import { createGroupsSlice, placeFolders, type GroupsSlice } from "./groups";
import { createHistorySlice, type HistorySlice } from "./history";
import { blankTabToShow, IDLE_LIVE, isIncognitoSpace, pinnedFirst, pinnedPage, spaceListKey, tabListKey, tabToShow, windowListKey } from "./model";
import { createOrganizeSlice, forgetClosedPrivateWindows, keptDeletedGroups, type OrganizeSlice } from "./organize";
import { createPeeksSlice, type PeeksSlice } from "./peeks";
import { createSpacesSlice, DEFAULT_SPACE, engineIdOf, isolateSavedSpaces, withSpaceEmoji, type SpacesSlice } from "./spaces";
import { createSettingsSlice, DEFAULT_SETTINGS, type SettingsSlice } from "./settings";
import { createSplitsSlice, sanitizeSplits, type SplitsSlice } from "./splits";
import { activated, apply, createTabsSlice, withNewTab, type TabsSlice } from "./tabs";
import type { BrowserWindow, PinnedFolder, Tab, TabGroup } from "./types";
import { createUiSlice, type UiSlice } from "./ui";
import { createWindowsSlice, type WindowsSlice } from "./windows";

export type BrowserState = SpacesSlice &
  WindowsSlice &
  TabsSlice &
  GroupsSlice &
  FoldersSlice &
  OrganizeSlice &
  SplitsSlice &
  PeeksSlice &
  HistorySlice &
  BookmarksSlice &
  SettingsSlice &
  UiSlice & {
    hydrate(data: HydrateData): void;
  };

export type HydrateData = Partial<
  Pick<
    BrowserState,
    | "spaces"
    | "spaceOrder"
    | "orphanedProfileData"
    | "windows"
    | "windowOrder"
    | "tabs"
    | "groups"
    | "pinnedFolders"
    | "splits"
    | "closedTabs"
    | "closedWindows"
    | "tabLists"
    | "closedGroups"
    | "deletedGroups"
    | "cleanedTabs"
    | "history"
    | "bookmarks"
    | "downloads"
    | "settings"
  >
> & {
  focusedWindowId?: string | null;
  // The app's launch (lib/persist.ts): windows show what settings.launchTab says, not always the tab they showed.
  launch?: boolean;
};

// A session from before tabs were their space's: each window kept its tabs, in its order.
type SavedWindow = BrowserWindow & { tabIds?: string[] };

// Groups and pinned folders were once saved with the window they were in; they belong to their space now.
function withoutWindowId<T extends { windowId?: string }>(saved: T): Omit<T, "windowId"> {
  const copy = { ...saved } as { windowId?: string } & Omit<T, "windowId">;
  delete copy.windowId;
  return copy;
}

// Batch external updates; React Native otherwise commits once per subscriber.
let batch = (update: () => void) => update();
export function setStoreBatching(batchedUpdates: (update: () => void) => void) {
  batch = batchedUpdates;
}
/** For the app's other stores: their subscribers re-render in one commit. */
export const batchStoreUpdates = (update: () => void) => batch(update);

const batched =
  <T>(creator: StateCreator<T>): StateCreator<T> =>
  (set, get, api) => {
    const batchedSet = ((...args: Parameters<typeof set>) => batch(() => (set as (...a: typeof args) => void)(...args))) as typeof set;
    api.setState = batchedSet;
    return creator(batchedSet, get, api);
  };

export const useBrowser = create<BrowserState>()(
  batched((...a) => ({
    ...createSpacesSlice(...a),
    ...createWindowsSlice(...a),
    ...createTabsSlice(...a),
    ...createGroupsSlice(...a),
    ...createFoldersSlice(...a),
    ...createOrganizeSlice(...a),
    ...createSplitsSlice(...a),
    ...createPeeksSlice(...a),
    ...createHistorySlice(...a),
    ...createBookmarksSlice(...a),
    ...createSettingsSlice(...a),
    ...createUiSlice(...a),

    hydrate(data) {
      const [set, get] = a;
      const s = get();
      const savedSpaces = data.spaces && Object.keys(data.spaces).length ? data.spaces : { [DEFAULT_SPACE.id]: DEFAULT_SPACE };
      const spaceOrder = [...new Set([...(data.spaceOrder ?? []).filter((id) => savedSpaces[id]), ...Object.keys(savedSpaces)])];
      const isolated = isolateSavedSpaces(savedSpaces, spaceOrder, data.orphanedProfileData ?? []);
      const { detached, owners } = isolated;
      const spaces = withSpaceEmoji(isolated.spaces, spaceOrder);
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (!spaces[settings.defaultSpaceId]) settings.defaultSpaceId = spaceOrder[0]!;

      const rawWindows: Record<string, SavedWindow> = data.windows ?? {};
      const spaceOk = (p: string) => !!spaces[p] || isIncognitoSpace(p);
      // A private window's tabs and a Little Bay's page only come back with their window.
      const kept = (w: SavedWindow | undefined) => !!w && (w.incognito || w.kind === "small");
      const tabs: Record<string, Tab> = {};
      for (const t of Object.values(data.tabs ?? {})) {
        const own = rawWindows[t.windowId];
        // A peek is thrown away with its window's session (store/peeks.ts).
        if (!spaceOk(t.spaceId) || (isIncognitoSpace(t.spaceId) && !own) || t.peekOf) continue;
        const { adoptId: _, wakeAdoptId: _wake, ...rest } = t;
        tabs[t.id] = { ...rest, windowId: own ? t.windowId : "", navigation: null, pinnedUrl: rest.pinnedUrl ?? (pinnedPage(rest) ? rest.url || null : null) };
      }
      // Each list: the saved one's order, then (an older session) each window's.
      const lookup = { spaces, windows: rawWindows };
      const lists: Record<string, string[]> = {};
      const add = (id: string) => {
        const t = tabs[id];
        if (!t) return;
        const list = (lists[tabListKey(lookup, t)] ??= []);
        if (!list.includes(id)) list.push(id);
      };
      for (const ids of Object.values(data.tabLists ?? {})) ids.forEach(add);
      for (const w of Object.values(rawWindows)) (w.tabIds ?? []).forEach(add);
      Object.keys(tabs).forEach(add);
      const tabLists = Object.fromEntries(Object.entries(lists).map(([key, ids]) => [key, placeFolders(pinnedFirst(ids, tabs), tabs)]));

      const windows: Record<string, BrowserWindow> = {};
      for (const { tabIds: _, ...w } of Object.values(rawWindows)) {
        if (kept(w) && !tabLists[windowListKey(lookup, w)]) continue;
        const spaceId = w.incognito || w.kind === "small" || spaces[w.spaceId] ? w.spaceId : settings.defaultSpaceId;
        const listed = (p: string, id: string) =>
          !!tabs[id] && (w.kind === "small" ? tabs[id]!.windowId === w.id : tabListKey(lookup, tabs[id]!) === spaceListKey({ spaces }, p));
        windows[w.id] = { ...w, spaceId, activeTabIds: Object.fromEntries(Object.entries(w.activeTabIds).filter(([p, id]) => listed(p, id))) };
      }
      for (const t of Object.values(tabs)) if (t.windowId && !windows[t.windowId]) tabs[t.id] = { ...t, windowId: "" };
      const windowOrder = [...(data.windowOrder ?? []).filter((id) => windows[id]), ...Object.keys(windows).filter((id) => !data.windowOrder?.includes(id))];
      type SavedGroup = TabGroup & { windowId?: string };
      const groups = Object.fromEntries(
        Object.values((data.groups ?? {}) as Record<string, SavedGroup>)
          .map((saved) => {
            const g = withoutWindowId(saved);
            return { ...g, tabIds: g.tabIds.filter((id) => tabs[id]?.spaceId === g.spaceId) };
          })
          .filter((g) => g.tabIds.length)
          .map((g) => [g.id, g]),
      );
      const splits = sanitizeSplits(data.splits ?? {}, tabs);
      let bookmarks = data.bookmarks ?? EMPTY_BOOKMARKS;
      const history: BrowserState["history"] = {};
      const replacedRoots = new Set<string>();
      // Shared native data stays with its canonical owner. Other spaces retain their tabs but start clean.
      for (const [owner, ids] of owners) {
        const source = [owner, ...ids].find((id) => data.history?.[id]);
        if (source) history[owner] = data.history![source]!;
        const roots = [owner, ...ids].map((id) => bookmarks.roots[id]).find(Boolean);
        if (roots) {
          const expected = rootIdsFor(engineIdOf(spaces[owner]!));
          const nodes = { ...bookmarks.nodes };
          for (const kind of ["bar", "other"] as const) {
            const from = roots[kind];
            const to = expected[kind];
            const node = nodes[from];
            if (from === to || node?.kind !== "folder") continue;
            nodes[to] = { ...node, id: to };
            replacedRoots.add(from);
            for (const child of node.children) if (nodes[child]) nodes[child] = { ...nodes[child]!, parentId: to };
          }
          bookmarks = { nodes, roots: { ...bookmarks.roots, [owner]: expected } };
        }
      }
      for (const id of spaceOrder) {
        const engine = engineIdOf(spaces[id]!);
        if (detached.has(id)) {
          const roots = rootIdsFor(engine);
          const nodes = { ...bookmarks.nodes };
          delete nodes[roots.bar];
          delete nodes[roots.other];
          bookmarks = { ...bookmarks, nodes };
        }
        bookmarks = engineRoots(bookmarks, id, engine)[0];
      }
      // Replaced permanent folders are aliases, not another bookmark tree.
      if (replacedRoots.size) {
        const liveRoots = new Set(spaceOrder.flatMap((id) => Object.values(bookmarks.roots[id]!)));
        const nodes = { ...bookmarks.nodes };
        for (const id of replacedRoots) if (!liveRoots.has(id)) delete nodes[id];
        bookmarks = { ...bookmarks, nodes };
      }
      const focused = data.focusedWindowId && windows[data.focusedWindowId] ? data.focusedWindowId : (windowOrder.at(-1) ?? null);

      const engines = new Set(Object.values(spaces).map(engineIdOf));
      let next: BrowserState = {
        ...s,
        spaces,
        spaceOrder,
        orphanedProfileData: (data.orphanedProfileData ?? []).filter((e) => !engines.has(e)),
        settings,
        windows,
        windowOrder,
        tabs,
        tabLists,
        live: Object.fromEntries(Object.keys(tabs).map((id) => [id, IDLE_LIVE])),
        groups,
        pinnedFolders: Object.fromEntries(
          Object.values(data.pinnedFolders ?? {})
            .filter((f) => spaces[f.spaceId])
            .map((saved: PinnedFolder & { windowId?: string }) => [saved.id, withoutWindowId(saved)]),
        ),
        splits,
        closedTabs: data.closedTabs ?? [],
        closedWindows: data.closedWindows ?? [],
        closedGroups: data.closedGroups ?? [],
        deletedGroups: keptDeletedGroups(data.deletedGroups ?? []),
        // Older builds saved private windows' cleaned tabs; drop them.
        cleanedTabs: (data.cleanedTabs ?? []).filter((c) => !isIncognitoSpace(c.tab.spaceId)),
        privateCleanedTabs: {},
        privateSiteMutes: {},
        selection: {},
        peeks: {},
        closedPeeks: {},
        history,
        historyFloor: {},
        // A view handed in (tests) counts as read; the app's history and bookmarks come from Chrome later
        // (lib/history.ts, lib/bookmarks.ts).
        historyReady: Object.fromEntries(Object.keys(history).map((p) => [p, true as const])),
        bookmarks,
        bookmarksReady: Object.fromEntries(
          Object.keys(data.bookmarks?.roots ?? {})
            .filter((p) => spaces[p] && !detached.has(p))
            .map((p) => [p, true as const]),
        ),
        downloads: data.downloads ?? [],
        windowUi: {},
        find: {},
        ui: { ...s.ui, focusedWindowId: focused, focusOrder: focused ? [focused, ...windowOrder.filter((id) => id !== focused).reverse()] : [] },
      };
      next = prunePinnedFolders(next);
      // Each window shows the tab it showed, else its space's most recent one, else a new tab. A launch that starts on
      // a new tab shows a blank one, its space's tabs waiting in the sidebar.
      const blank = data.launch && settings.launchTab === "newTab";
      for (const w of Object.values(windows)) {
        const shown = blank ? blankTabToShow(next, w.id, w.spaceId) : tabToShow(next, w.id, w.spaceId);
        next = shown ? apply(next, activated(next, shown, w.id)) : withNewTab(next, w.id)[0];
      }
      set(next);
    },
  })),
);

useBrowser.subscribe((s, prev) => {
  const patch = s.windows !== prev.windows && forgetClosedPrivateWindows(s);
  if (patch) useBrowser.setState(patch);
});

export type { CreateWindowOptions } from "./windows";
