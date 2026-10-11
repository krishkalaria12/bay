import type { StateCreator } from "zustand";
import type { BrowserState } from "./browser";
import { bookmarkRoots, engineRoots, removeBookmarkTree } from "./bookmarks";
import { newId, setSpaceProfiles, tabToShow, viewTabIds, without } from "./model";
import { DEFAULT_GRAIN, DEFAULT_INTENSITY } from "../lib/constants";
import { THEME_PRESETS } from "../lib/spaceTheme";
import { SPACE_SWATCHES } from "../lib/spaceSwatches";
import { DEFAULT_SPACE_ID } from "./constants";
import { activated, apply, removeTabs, withNewTab } from "./tabs";
import type { Space, SpaceColor, SpaceTheme } from "./types";

export type SpacesSlice = {
  spaces: Record<string, Space>;
  spaceOrder: string[];
  // Engine spaces whose data a deleted profile left behind, until it's gone (lib/profileData.ts).
  orphanedProfileData: string[];

  /** Without a colour or theme, the space gets a look no other space has (unusedSpaceLook). */
  /** `shareWith`: a space whose sign-ins (native profile) the new one shares; else it gets its own, signed out. */
  createSpace(options: { name: string; color?: SpaceColor; theme?: SpaceTheme | null; icon?: string | null; shareWith?: string | null }): string;
  updateSpace(id: string, patch: Partial<Pick<Space, "name" | "color" | "icon" | "theme" | "followSite" | "cleanUpAfterHours">>): void;
  deleteSpace(id: string): void;
  reorderSpaces(ids: string[]): void;
  setDefaultSpace(id: string): void;
  profileDataDeleted(engineId: string): void;
};

function presetTheme(name: string): SpaceTheme {
  return { colors: [...THEME_PRESETS.find((p) => p.name === name)!.colors], intensity: DEFAULT_INTENSITY, grain: DEFAULT_GRAIN };
}

// A new install's first space wears Arc's best-loved look: the Twilight gradient (violet into fuchsia), with grain.
export const DEFAULT_SPACE: Space = {
  id: DEFAULT_SPACE_ID,
  name: "Personal",
  color: "purple",
  icon: "🏠",
  createdAt: 0,
  theme: presetTheme("Twilight"),
};

const COLORS: SpaceColor[] = ["blue", "green", "orange", "purple", "red", "yellow", "pink"];

export const unusedSpaceColor = (spaces: Record<string, Space>): SpaceColor => COLORS.find((c) => !Object.values(spaces).some((p) => p.color === c)) ?? "blue";

// The gradients a new space takes in turn, each with the preset colour nearest it (what shows where one colour does).
const LOOKS: [string, SpaceColor][] = [
  ["Twilight", "purple"],
  ["Sunset", "orange"],
  ["Aurora", "green"],
  ["Dusk", "blue"],
];

/** The looks a space can start from: the gradients, then each preset colour's (the new space sheet offers them). */
export const SPACE_LOOKS: { name: string; color: SpaceColor; theme: SpaceTheme }[] = LOOKS.map(([name, color]) => ({ name, color, theme: presetTheme(name) }));

/**
 * A new space's look, so that no two spaces look alike: the first gradient no space wears, then a theme of a colour
 * no space has. Always a theme, so the space shows as itself over any page.
 */
export function unusedSpaceLook(spaces: Record<string, Space>): { color: SpaceColor; theme: SpaceTheme } {
  const worn = new Set(Object.values(spaces).map((p) => p.theme?.colors.join()));
  const look = LOOKS.find(([name]) => !worn.has(presetTheme(name).colors.join()));
  if (look) return { color: look[1], theme: presetTheme(look[0]) };
  return themeOfColor(unusedSpaceColor(spaces));
}

/** A space's look from one of the preset colours: its swatch, as a theme. */
export function themeOfColor(color: SpaceColor): { color: SpaceColor; theme: SpaceTheme } {
  return { color, theme: { colors: [SPACE_SWATCHES[color]], intensity: DEFAULT_INTENSITY, grain: DEFAULT_GRAIN } };
}

// Each space owns a native profile. profileId preserves existing native directories after upgrades.
export const profileIdOf = (space: Space) => space.profileId || space.id;
export const engineIdOf = (space: Space) => (profileIdOf(space) === DEFAULT_SPACE_ID ? "" : profileIdOf(space));

/**
 * The space that syncs its profile's data (bookmarks, history, passwords): with shared sign-ins several spaces use one
 * profile, and only one may sync it (else the same data goes up twice). The one the profile is named after, else the
 * first using it.
 */
export function ownsProfileData(s: Pick<BrowserState, "spaces" | "spaceOrder">, id: string): boolean {
  const space = s.spaces[id];
  if (!space) return false;
  const profile = profileIdOf(space);
  const named = s.spaces[profile];
  if (named && profileIdOf(named) === profile) return profile === id;
  return s.spaceOrder.find((other) => s.spaces[other] && profileIdOf(s.spaces[other]!) === profile) === id;
}

/** Split older shared profiles without discarding the original owner's native data. */
export function isolateSavedSpaces(spaces: Record<string, Space>, order: string[], orphaned: string[]) {
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const profile = profileIdOf(spaces[id]!);
    groups.set(profile, [...(groups.get(profile) ?? []), id]);
  }
  const reserved = new Set([...groups.keys(), ...Object.keys(spaces), ...orphaned.map((id) => id || DEFAULT_SPACE_ID)]);
  const next = { ...spaces };
  const detached = new Set<string>();
  const owners = new Map<string, string[]>();
  for (const [profile, ids] of groups) {
    const owner = ids.includes(profile) ? profile : ids[0]!;
    owners.set(owner, ids);
    for (const id of ids) {
      // A space made to share its sign-ins stays with them; only older, unchosen sharing is split.
      if (id === owner || spaces[id]!.sharesSignIns) continue;
      // Its former directory may belong to another space or still be queued for deletion.
      let nativeId = id;
      if (groups.has(id) || orphaned.includes(id === DEFAULT_SPACE_ID ? "" : id)) {
        nativeId = `${id}-isolated`;
        let suffix = 1;
        while (reserved.has(nativeId)) nativeId = `${id}-isolated-${suffix++}`;
      }
      reserved.add(nativeId);
      const { profileId: _, ...space } = spaces[id]!;
      next[id] = nativeId === id ? space : { ...space, profileId: nativeId };
      detached.add(id);
    }
  }
  return { spaces: next, detached, owners };
}

export const createSpacesSlice: StateCreator<BrowserState, [], [], SpacesSlice> = (set, get, api) => {
  api.subscribe((s, prev) => {
    if (s.spaces !== prev.spaces) {
      setSpaceProfiles(Object.fromEntries(Object.values(s.spaces).map((space) => [space.id, profileIdOf(space)])));
    }
  });

  return {
    spaces: { [DEFAULT_SPACE.id]: DEFAULT_SPACE },
    spaceOrder: [DEFAULT_SPACE.id],
    orphanedProfileData: [],

    createSpace({ name, color, theme, icon = null, shareWith }) {
      const s = get();
      const source = shareWith ? s.spaces[shareWith] : undefined;
      const look = color || theme !== undefined ? { color: color ?? unusedSpaceColor(s.spaces), theme: theme ?? null } : unusedSpaceLook(s.spaces);
      const profile: Space = {
        id: newId("p"),
        name: name.trim() || `Profile ${s.spaceOrder.length + 1}`,
        color: look.color,
        ...(look.theme ? { theme: look.theme } : {}),
        icon,
        createdAt: Date.now(),
        ...(source ? { profileId: profileIdOf(source), sharesSignIns: true } : {}),
      };
      const bookmarks = engineRoots(s.bookmarks, profile.id, engineIdOf(profile))[0];
      set({ spaces: { ...s.spaces, [profile.id]: profile }, spaceOrder: [...s.spaceOrder, profile.id], bookmarks });
      return profile.id;
    },

    updateSpace(id, patch) {
      set((s) => (s.spaces[id] ? { spaces: { ...s.spaces, [id]: { ...s.spaces[id]!, ...patch } } } : {}));
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
      const engine = engineIdOf(s.spaces[id]!);
      // Another space shares its sign-ins: the profile, and its bookmarks, stay theirs.
      const shared = spaceOrder.some((p) => engineIdOf(s.spaces[p]!) === engine);
      const orphaned = shared || s.orphanedProfileData.includes(engine) ? s.orphanedProfileData : [...s.orphanedProfileData, engine];

      // Its windows show the fallback space: the tab each showed there, else its most recent one, else a new one.
      for (const w of Object.values(s.windows)) {
        if (w.spaceId !== id || w.kind === "small") continue;
        let tab = tabToShow(s, w.id, fallback);
        if (!tab) [s, tab] = withNewTab(s, w.id, { spaceId: fallback, background: true });
        s = { ...s, windows: { ...s.windows, [w.id]: { ...s.windows[w.id]!, spaceId: fallback } } };
        s = apply(s, activated(s, tab, w.id));
      }
      s = removeTabs(
        s,
        Object.values(s.tabs)
          .filter((t) => t.spaceId === id)
          .map((t) => t.id),
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
        bookmarks:
          roots && !shared ? removeBookmarkTree(s.bookmarks, [roots.bar, roots.other], id) : { ...s.bookmarks, roots: without(s.bookmarks.roots, [id]) },
        groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => g.spaceId !== id)),
        closedTabs: s.closedTabs.filter((c) => c.tab.spaceId !== id),
        cleanedTabs: s.cleanedTabs.filter((c) => c.tab.spaceId !== id),
        closedGroups: s.closedGroups.filter((c) => c.tabs.every((t) => t.spaceId !== id)),
        deletedGroups: s.deletedGroups.filter((c) => c.tabs.every((t) => t.spaceId !== id)),
        closedWindows: s.closedWindows.filter((c) => c.window.spaceId !== id).map((c) => ({ ...c, tabs: c.tabs.filter((t) => t.spaceId !== id) })),
        pinnedFolders: Object.fromEntries(Object.entries(s.pinnedFolders).filter(([, f]) => f.spaceId !== id)),
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
