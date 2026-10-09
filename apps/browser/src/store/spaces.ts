import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { bookmarkRoots, engineRoots, ensureRoots, removeBookmarkTree } from "./bookmarks";
import { navigationTo, newId, setSpaceProfiles, viewTabIds, without } from "./model";
import { SYMBOL_PREFIX } from "../lib/constants";
import { DEFAULT_SPACE_ID } from "./constants";
import { activated, apply, removeTabs, withNewTab } from "./tabs";
import type { Space, SpaceColor } from "./types";

export type SpacesSlice = {
  spaces: Record<string, Space>;
  spaceOrder: string[];
  // Engine spaces whose data a deleted profile left behind, until it's gone (lib/profileData.ts).
  orphanedProfileData: string[];

  createSpace(options: { name: string; color?: SpaceColor; icon?: string | null; shareWith?: string | null }): string;
  updateSpace(id: string, patch: Partial<Pick<Space, "name" | "color" | "icon" | "theme" | "cleanUpAfterHours">>): void;
  /** The space takes another space's profile (`shareWith`'s), or a new one of its own (null). */
  setSpaceProfile(id: string, shareWith: string | null): void;
  deleteSpace(id: string): void;
  reorderSpaces(ids: string[]): void;
  setDefaultSpace(id: string): void;
  profileDataDeleted(engineId: string): void;
};

export const DEFAULT_SPACE: Space = { id: DEFAULT_SPACE_ID, name: "Personal", color: "plum", icon: `${SYMBOL_PREFIX}house.fill`, createdAt: 0 };

const COLORS: SpaceColor[] = ["blue", "green", "orange", "purple", "red", "yellow", "pink"];

export const unusedSpaceColor = (spaces: Record<string, Space>): SpaceColor =>
  COLORS.find((c) => !Object.values(spaces).some((p) => p.color === c)) ?? "blue";

// MARK: Shared data

export const profileIdOf = (profile: Space) => profile.profileId ?? profile.id;
// The engine's profile id, as model.engineProfile maps it: the original profile's data is Chrome's default profile.
export const engineIdOf = (profile: Space) => (profileIdOf(profile) === DEFAULT_SPACE_ID ? "" : profileIdOf(profile));

export function profileGroups(s: Pick<BrowserState, "spaces" | "spaceOrder">): { profileId: string; spaceIds: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const id of s.spaceOrder) {
    const p = s.spaces[id];
    if (!p) continue;
    const key = profileIdOf(p);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups].map(([profileId, spaceIds]) => ({ profileId, spaceIds }));
}

/** The space that syncs its profile's data: the one the data is named after while it uses it, else the first using it. */
export function ownsProfileData(s: Pick<BrowserState, "spaces" | "spaceOrder">, id: string): boolean {
  const p = s.spaces[id];
  if (!p) return false;
  const profileId = profileIdOf(p);
  const named = s.spaces[profileId];
  if (named && profileIdOf(named) === profileId) return profileId === id;
  return s.spaceOrder.find((other) => s.spaces[other] && profileIdOf(s.spaces[other]!) === profileId) === id;
}

export function sharingSpaces(s: Pick<BrowserState, "spaces" | "spaceOrder">, id: string): string[] {
  const p = s.spaces[id];
  if (!p) return [];
  return s.spaceOrder.filter((other) => other !== id && s.spaces[other] && profileIdOf(s.spaces[other]!) === profileIdOf(p));
}

function syncSharedData(s: BrowserState, prev: BrowserState): Partial<BrowserState> | null {
  if (s.spaces !== prev.spaces) {
    setSpaceProfiles(Object.fromEntries(Object.values(s.spaces).filter((p) => p.profileId).map((p) => [p.id, p.profileId!])));
  }
  if (s.spaces === prev.spaces && s.history === prev.history && s.bookmarks.roots === prev.bookmarks.roots) return null;
  let history = s.history;
  let roots = s.bookmarks.roots;
  for (const { profileId, spaceIds } of profileGroups(s)) {
    if (spaceIds.length < 2) continue;
    const changed = spaceIds.find((id) => s.history[id] !== prev.history[id]);
    const list = s.history[changed ?? spaceIds.find((id) => s.history[id]) ?? ""];
    if (list) for (const id of spaceIds) if (history[id] !== list) history = { ...history, [id]: list };
    const shared = roots[profileId] ?? roots[spaceIds.find((id) => roots[id]) ?? ""];
    if (shared) for (const id of spaceIds) if (roots[id]?.bar !== shared.bar || roots[id]?.other !== shared.other) roots = { ...roots, [id]: shared };
  }
  if (history === s.history && roots === s.bookmarks.roots) return null;
  return { history, bookmarks: roots === s.bookmarks.roots ? s.bookmarks : { ...s.bookmarks, roots } };
}

export const createSpacesSlice: StateCreator<BrowserState, [], [], SpacesSlice> = (set, get, api) => {
  api.subscribe((s, prev) => {
    const patch = syncSharedData(s, prev);
    if (patch) set(patch);
  });

  return {
    spaces: { [DEFAULT_SPACE.id]: DEFAULT_SPACE },
    spaceOrder: [DEFAULT_SPACE.id],
    orphanedProfileData: [],

    createSpace({ name, color, icon = null, shareWith }) {
      const s = get();
      const source = shareWith ? s.spaces[shareWith] : undefined;
      const profile: Space = {
        id: newId("p"),
        name: name.trim() || `Profile ${s.spaceOrder.length + 1}`,
        color: color ?? unusedSpaceColor(s.spaces),
        icon,
        createdAt: Date.now(),
        ...(source ? { profileId: profileIdOf(source) } : {}),
      };
      let bookmarks = s.bookmarks;
      let history = s.history;
      if (source) {
        const [withRoots, roots] = ensureRoots(bookmarks, source.id);
        bookmarks = { ...withRoots, roots: { ...withRoots.roots, [profile.id]: roots } };
        if (s.history[source.id]) history = { ...history, [profile.id]: s.history[source.id]! };
      } else {
        bookmarks = ensureRoots(bookmarks, profile.id)[0];
      }
      set({ spaces: { ...s.spaces, [profile.id]: profile }, spaceOrder: [...s.spaceOrder, profile.id], bookmarks, history });
      return profile.id;
    },

    updateSpace(id, patch) {
      set((s) => (s.spaces[id] ? { spaces: { ...s.spaces, [id]: { ...s.spaces[id]!, ...patch } } } : {}));
    },

    setSpaceProfile(id, shareWith) {
      const s = get();
      const p = s.spaces[id];
      const target = shareWith ? s.spaces[shareWith] : undefined;
      if (!p || (shareWith && !target)) return;
      const from = profileIdOf(p);
      let profileId: string;
      if (target) {
        profileId = profileIdOf(target);
        if (profileId === from) return;
      } else {
        if (!sharingSpaces(s, id).length) return;
        // Its own id names its new profile, unless other spaces' profile has it (or that data is still going).
        const free = !Object.values(s.spaces).some((o) => o.id !== id && profileIdOf(o) === id) && !s.orphanedProfileData.includes(engineIdOf({ ...p, profileId: id }));
        profileId = free ? id : newId("d");
      }
      const { profileId: _, ...rest } = p;
      const moved: Space = profileId === id ? rest : { ...rest, profileId };
      const spaces = { ...s.spaces, [id]: moved };
      const left = engineIdOf(p);
      const kept = Object.values(spaces).some((o) => profileIdOf(o) === from);
      const orphanedProfileData = kept || s.orphanedProfileData.includes(left) ? s.orphanedProfileData : [...s.orphanedProfileData, left];

      // Its bookmarks and history are its new profile's: another space's, or none until Chrome's are read.
      const oldRoots = bookmarkRoots(s.bookmarks, id);
      let bookmarks = oldRoots && !kept ? removeBookmarkTree(s.bookmarks, [oldRoots.bar, oldRoots.other]) : s.bookmarks;
      bookmarks = target ? ensureRoots(bookmarks, target.id)[0] : bookmarks;
      bookmarks = engineRoots(bookmarks, id, engineIdOf(moved))[0];
      const shared = target ? s.history[target.id] : undefined;
      const history = shared ? { ...s.history, [id]: shared } : without(s.history, [id]);
      const ready = (map: Record<string, true>) => (target && map[target.id] ? { ...map, [id]: true as const } : without(map, [id]));

      // Its pages are the old profile's: each reloads in the new one, as a tab moved to another profile does.
      const tabs = { ...s.tabs };
      for (const t of Object.values(s.tabs)) {
        if (t.spaceId !== id) continue;
        const loaded = !!t.url && (!!t.navigation || !!t.adoptId);
        const { adoptId: _a, wakeAdoptId: _w, ...tab } = t;
        tabs[t.id] = { ...tab, navigation: loaded ? navigationTo(t.url) : null };
      }
      set({
        spaces,
        orphanedProfileData,
        bookmarks,
        history,
        historyReady: ready(s.historyReady),
        bookmarksReady: ready(s.bookmarksReady),
        tabs,
      });
    },

    deleteSpace(id) {
      let s = get();
      if (!s.spaces[id] || s.spaceOrder.length <= 1) return;
      const spaceOrder = s.spaceOrder.filter((p) => p !== id);
      const fallback = s.settings.defaultSpaceId === id ? spaceOrder[0]! : s.settings.defaultSpaceId;
      const settings = {
        ...s.settings,
        defaultSpaceId: s.settings.defaultSpaceId === id ? fallback : s.settings.defaultSpaceId,
        neverTranslateSites: without(s.settings.neverTranslateSites ?? {}, [id]),
      };
      const shared = sharingSpaces(s, id).length > 0;
      const engine = engineIdOf(s.spaces[id]!);
      const orphaned = spaceOrder.some((p) => engineIdOf(s.spaces[p]!) === engine) || s.orphanedProfileData.includes(engine)
        ? s.orphanedProfileData
        : [...s.orphanedProfileData, engine];

      for (const w of Object.values(s.windows)) {
        if (w.spaceId !== id) continue;
        const other = w.tabIds.find((t) => s.tabs[t]?.spaceId !== id);
        if (other) s = apply(s, activated(s, w.activeTabIds[s.tabs[other]!.spaceId] ?? other));
        else {
          const [next, tab] = withNewTab(s, w.id, { spaceId: fallback, background: true });
          s = apply(next, activated(next, tab));
        }
      }
      s = removeTabs(
        s,
        Object.values(s.tabs).filter((t) => t.spaceId === id).map((t) => t.id),
        false,
      );
      const windows = { ...s.windows };
      for (const w of Object.values(windows)) {
        if (w.activeTabIds[id]) windows[w.id] = { ...w, activeTabIds: without(w.activeTabIds, [id]) };
      }
      const roots = bookmarkRoots(s.bookmarks, id);
      set({
        ...s,
        windows,
        spaces: without(s.spaces, [id]),
        spaceOrder,
        orphanedProfileData: orphaned,
        settings,
        history: without(s.history, [id]),
        bookmarks: roots && !shared ? removeBookmarkTree(s.bookmarks, [roots.bar, roots.other], id) : { ...s.bookmarks, roots: without(s.bookmarks.roots, [id]) },
        groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => g.spaceId !== id)),
        closedTabs: s.closedTabs.filter((c) => c.tab.spaceId !== id),
        cleanedTabs: s.cleanedTabs.filter((c) => c.tab.spaceId !== id),
        closedGroups: s.closedGroups.filter((c) => c.tabs.every((t) => t.spaceId !== id)),
        deletedGroups: s.deletedGroups.filter((c) => c.tabs.every((t) => t.spaceId !== id)),
        closedWindows: s.closedWindows
          .map((c) => ({ ...c, tabs: c.tabs.filter((t) => t.spaceId !== id) }))
          .filter((c) => c.tabs.length > 0),
        parkedPins: without(s.parkedPins, [id]),
      });
      for (const w of Object.values(get().windows)) {
        if (!viewTabIds(get(), w.id).length) get().newTab(w.id);
      }
    },

    reorderSpaces(ids) {
      set((s) => {
        const known = ids.filter((id) => s.spaces[id]);
        return { spaceOrder: [...known, ...s.spaceOrder.filter((id) => !known.includes(id))] };
      });
    },

    setDefaultSpace(id) {
      set((s) => (s.spaces[id] ? { settings: { ...s.settings, defaultSpaceId: id } } : {}));
    },

    profileDataDeleted(engineId) {
      set((s) => (s.orphanedProfileData.includes(engineId) ? { orphanedProfileData: s.orphanedProfileData.filter((e) => e !== engineId) } : {}));
    },
  };
};
