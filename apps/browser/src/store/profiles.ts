import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { bookmarkRoots, engineRoots, ensureRoots, removeBookmarkTree } from "./bookmarks";
import { navigationTo, newId, setSharedDataIds, viewTabIds, without } from "./model";
import { SYMBOL_PREFIX } from "../lib/constants";
import { DEFAULT_PROFILE_ID } from "./constants";
import { activated, apply, removeTabs, withNewTab } from "./tabs";
import type { Profile, ProfileColor } from "./types";

export type ProfilesSlice = {
  profiles: Record<string, Profile>;
  profileOrder: string[];
  // Engine profiles whose data a deleted profile left behind, until it's gone (lib/profileData.ts).
  orphanedProfileData: string[];

  createProfile(options: { name: string; color?: ProfileColor; icon?: string | null; shareWith?: string | null }): string;
  updateProfile(id: string, patch: Partial<Pick<Profile, "name" | "color" | "icon" | "theme" | "cleanUpAfterHours">>): void;
  /** The space takes another space's profile (`shareWith`'s), or a new one of its own (null). */
  changeProfileData(id: string, shareWith: string | null): void;
  deleteProfile(id: string): void;
  reorderProfiles(ids: string[]): void;
  setDefaultProfile(id: string): void;
  profileDataDeleted(engineId: string): void;
};

export const DEFAULT_PROFILE: Profile = { id: DEFAULT_PROFILE_ID, name: "Personal", color: "plum", icon: `${SYMBOL_PREFIX}house.fill`, createdAt: 0 };

const COLORS: ProfileColor[] = ["blue", "green", "orange", "purple", "red", "yellow", "pink"];

export const unusedProfileColor = (profiles: Record<string, Profile>): ProfileColor =>
  COLORS.find((c) => !Object.values(profiles).some((p) => p.color === c)) ?? "blue";

// MARK: Shared data

export const dataIdOf = (profile: Profile) => profile.dataId ?? profile.id;
// The engine's profile id, as model.engineProfile maps it: the original profile's data is Chrome's default profile.
export const engineIdOf = (profile: Profile) => (dataIdOf(profile) === DEFAULT_PROFILE_ID ? "" : dataIdOf(profile));

export function dataGroups(s: Pick<BrowserState, "profiles" | "profileOrder">): { dataId: string; profileIds: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const id of s.profileOrder) {
    const p = s.profiles[id];
    if (!p) continue;
    const key = dataIdOf(p);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups].map(([dataId, profileIds]) => ({ dataId, profileIds }));
}

/** The space that syncs its profile's data: the one the data is named after while it uses it, else the first using it. */
export function ownsProfileData(s: Pick<BrowserState, "profiles" | "profileOrder">, id: string): boolean {
  const p = s.profiles[id];
  if (!p) return false;
  const dataId = dataIdOf(p);
  const named = s.profiles[dataId];
  if (named && dataIdOf(named) === dataId) return dataId === id;
  return s.profileOrder.find((other) => s.profiles[other] && dataIdOf(s.profiles[other]!) === dataId) === id;
}

export function sharingProfiles(s: Pick<BrowserState, "profiles" | "profileOrder">, id: string): string[] {
  const p = s.profiles[id];
  if (!p) return [];
  return s.profileOrder.filter((other) => other !== id && s.profiles[other] && dataIdOf(s.profiles[other]!) === dataIdOf(p));
}

function syncSharedData(s: BrowserState, prev: BrowserState): Partial<BrowserState> | null {
  if (s.profiles !== prev.profiles) {
    setSharedDataIds(Object.fromEntries(Object.values(s.profiles).filter((p) => p.dataId).map((p) => [p.id, p.dataId!])));
  }
  if (s.profiles === prev.profiles && s.history === prev.history && s.bookmarks.roots === prev.bookmarks.roots) return null;
  let history = s.history;
  let roots = s.bookmarks.roots;
  for (const { dataId, profileIds } of dataGroups(s)) {
    if (profileIds.length < 2) continue;
    const changed = profileIds.find((id) => s.history[id] !== prev.history[id]);
    const list = s.history[changed ?? profileIds.find((id) => s.history[id]) ?? ""];
    if (list) for (const id of profileIds) if (history[id] !== list) history = { ...history, [id]: list };
    const shared = roots[dataId] ?? roots[profileIds.find((id) => roots[id]) ?? ""];
    if (shared) for (const id of profileIds) if (roots[id]?.bar !== shared.bar || roots[id]?.other !== shared.other) roots = { ...roots, [id]: shared };
  }
  if (history === s.history && roots === s.bookmarks.roots) return null;
  return { history, bookmarks: roots === s.bookmarks.roots ? s.bookmarks : { ...s.bookmarks, roots } };
}

export const createProfilesSlice: StateCreator<BrowserState, [], [], ProfilesSlice> = (set, get, api) => {
  api.subscribe((s, prev) => {
    const patch = syncSharedData(s, prev);
    if (patch) set(patch);
  });

  return {
    profiles: { [DEFAULT_PROFILE.id]: DEFAULT_PROFILE },
    profileOrder: [DEFAULT_PROFILE.id],
    orphanedProfileData: [],

    createProfile({ name, color, icon = null, shareWith }) {
      const s = get();
      const source = shareWith ? s.profiles[shareWith] : undefined;
      const profile: Profile = {
        id: newId("p"),
        name: name.trim() || `Profile ${s.profileOrder.length + 1}`,
        color: color ?? unusedProfileColor(s.profiles),
        icon,
        createdAt: Date.now(),
        ...(source ? { dataId: dataIdOf(source) } : {}),
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
      set({ profiles: { ...s.profiles, [profile.id]: profile }, profileOrder: [...s.profileOrder, profile.id], bookmarks, history });
      return profile.id;
    },

    updateProfile(id, patch) {
      set((s) => (s.profiles[id] ? { profiles: { ...s.profiles, [id]: { ...s.profiles[id]!, ...patch } } } : {}));
    },

    changeProfileData(id, shareWith) {
      const s = get();
      const p = s.profiles[id];
      const target = shareWith ? s.profiles[shareWith] : undefined;
      if (!p || (shareWith && !target)) return;
      const from = dataIdOf(p);
      let dataId: string;
      if (target) {
        dataId = dataIdOf(target);
        if (dataId === from) return;
      } else {
        if (!sharingProfiles(s, id).length) return;
        // Its own id names its new profile, unless other spaces' profile has it (or that data is still going).
        const free = !Object.values(s.profiles).some((o) => o.id !== id && dataIdOf(o) === id) && !s.orphanedProfileData.includes(engineIdOf({ ...p, dataId: id }));
        dataId = free ? id : newId("d");
      }
      const { dataId: _, ...rest } = p;
      const moved: Profile = dataId === id ? rest : { ...rest, dataId };
      const profiles = { ...s.profiles, [id]: moved };
      const left = engineIdOf(p);
      const kept = Object.values(profiles).some((o) => dataIdOf(o) === from);
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
        if (t.profileId !== id) continue;
        const loaded = !!t.url && (!!t.navigation || !!t.adoptId);
        const { adoptId: _a, wakeAdoptId: _w, ...tab } = t;
        tabs[t.id] = { ...tab, navigation: loaded ? navigationTo(t.url) : null };
      }
      set({
        profiles,
        orphanedProfileData,
        bookmarks,
        history,
        historyReady: ready(s.historyReady),
        bookmarksReady: ready(s.bookmarksReady),
        tabs,
      });
    },

    deleteProfile(id) {
      let s = get();
      if (!s.profiles[id] || s.profileOrder.length <= 1) return;
      const profileOrder = s.profileOrder.filter((p) => p !== id);
      const fallback = s.settings.defaultProfileId === id ? profileOrder[0]! : s.settings.defaultProfileId;
      const settings = {
        ...s.settings,
        defaultProfileId: s.settings.defaultProfileId === id ? fallback : s.settings.defaultProfileId,
        neverTranslateSites: without(s.settings.neverTranslateSites ?? {}, [id]),
      };
      const shared = sharingProfiles(s, id).length > 0;
      const engine = engineIdOf(s.profiles[id]!);
      const orphaned = profileOrder.some((p) => engineIdOf(s.profiles[p]!) === engine) || s.orphanedProfileData.includes(engine)
        ? s.orphanedProfileData
        : [...s.orphanedProfileData, engine];

      for (const w of Object.values(s.windows)) {
        if (w.profileId !== id) continue;
        const other = w.tabIds.find((t) => s.tabs[t]?.profileId !== id);
        if (other) s = apply(s, activated(s, w.activeTabIds[s.tabs[other]!.profileId] ?? other));
        else {
          const [next, tab] = withNewTab(s, w.id, { profileId: fallback, background: true });
          s = apply(next, activated(next, tab));
        }
      }
      s = removeTabs(
        s,
        Object.values(s.tabs).filter((t) => t.profileId === id).map((t) => t.id),
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
        profiles: without(s.profiles, [id]),
        profileOrder,
        orphanedProfileData: orphaned,
        settings,
        history: without(s.history, [id]),
        bookmarks: roots && !shared ? removeBookmarkTree(s.bookmarks, [roots.bar, roots.other], id) : { ...s.bookmarks, roots: without(s.bookmarks.roots, [id]) },
        groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => g.profileId !== id)),
        closedTabs: s.closedTabs.filter((c) => c.tab.profileId !== id),
        cleanedTabs: s.cleanedTabs.filter((c) => c.tab.profileId !== id),
        closedGroups: s.closedGroups.filter((c) => c.tabs.every((t) => t.profileId !== id)),
        deletedGroups: s.deletedGroups.filter((c) => c.tabs.every((t) => t.profileId !== id)),
        closedWindows: s.closedWindows
          .map((c) => ({ ...c, tabs: c.tabs.filter((t) => t.profileId !== id) }))
          .filter((c) => c.tabs.length > 0),
        parkedPins: without(s.parkedPins, [id]),
      });
      for (const w of Object.values(get().windows)) {
        if (!viewTabIds(get(), w.id).length) get().newTab(w.id);
      }
    },

    reorderProfiles(ids) {
      set((s) => {
        const known = ids.filter((id) => s.profiles[id]);
        return { profileOrder: [...known, ...s.profileOrder.filter((id) => !known.includes(id))] };
      });
    },

    setDefaultProfile(id) {
      set((s) => (s.profiles[id] ? { settings: { ...s.settings, defaultProfileId: id } } : {}));
    },

    profileDataDeleted(engineId) {
      set((s) => (s.orphanedProfileData.includes(engineId) ? { orphanedProfileData: s.orphanedProfileData.filter((e) => e !== engineId) } : {}));
    },
  };
};
