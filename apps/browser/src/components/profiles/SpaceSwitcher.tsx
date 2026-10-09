import { ContextMenuArea, prompt, showMenu, Symbol } from "@bay/shell";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";
import { createProfile, deleteProfile, switchProfile } from "../../lib/actions";
import { PROFILE_COLORS, useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import type { ProfileColor } from "../../store/types";
import { usePagerOpacity, usePagerPages, type PagerPage } from "../layout/profilePager";
import { IconButton, useHover } from "../primitives";
import { openSettings } from "../settings/windows";
import { useSidebarWidth } from "../sidebar/tokens";
import { iconMenuItems, profileSymbol } from "./icons";
import { openThemeEditor } from "./ThemeEditor";
import { ProfileDots } from "./ProfileDots";
import { PROFILE_DOTS_HEIGHT, SPACE_CELL, SPACE_GLYPH, SPACE_HOVERED_OPACITY, SPACE_IDLE_OPACITY, SPACE_PLUS, SPACE_SELECTED_OPACITY, SPACE_SIDE } from "./constants";

// Arc's space switcher, at the foot of the sidebar: a space's icon each (Bay's profiles are Arc's spaces), the shown
// one at full strength as the pager moves, and + for a new space. Dots once the icons don't fit.

export function SpaceSwitcher({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.profileOrder));
  const width = useSidebarWidth(windowId);
  const { pages } = usePagerPages(windowId);
  const fits = ids.length * SPACE_CELL <= width - 2 * (layout.sidebarInset + SPACE_SIDE);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT }}>
      {fits ? (
        <View style={{ height: PROFILE_DOTS_HEIGHT - 3, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          {ids.map((id) => (
            <SpaceIcon key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} />
          ))}
        </View>
      ) : (
        <ProfileDots windowId={windowId} />
      )}
      <View style={{ position: "absolute", right: layout.sidebarInset, top: (PROFILE_DOTS_HEIGHT - 3 - SPACE_PLUS) / 2 }}>
        <IconButton icon="plus" size={14} box={SPACE_PLUS} radius={8} tooltip="New Space" onPress={() => void newSpace(windowId)} />
      </View>
    </View>
  );
}

function SpaceIcon({ id, windowId, page }: { id: string; windowId: string; page: PagerPage | undefined }) {
  const theme = useTheme();
  const profile = useBrowser((s) => s.profiles[id]);
  const { hovered, hoverProps } = useHover();
  const opacity = usePagerOpacity(windowId, page?.slot, hovered ? SPACE_HOVERED_OPACITY : SPACE_IDLE_OPACITY, SPACE_SELECTED_OPACITY);
  if (!profile) return null;
  const ink = theme.dark ? "#FFFFFF" : "#000000";
  const symbol = profileSymbol(profile.icon);
  return (
    <View {...hoverProps} tooltip={profile.name}>
      <ContextMenuArea onContextMenu={() => void openSpaceMenu(windowId, id)}>
        <Pressable accessibilityRole="button" accessibilityLabel={profile.name} onPress={() => switchProfile(windowId, id, true)}>
          <Animated.View style={[{ width: SPACE_CELL, height: SPACE_CELL, borderRadius: 7, alignItems: "center", justifyContent: "center" }, opacity]}>
            {symbol ? (
              <Symbol name={symbol} size={SPACE_GLYPH - 2} weight="semibold" color={ink} style={{ width: SPACE_GLYPH + 2, height: SPACE_GLYPH + 2 }} />
            ) : (
              <Text style={{ fontSize: profile.icon ? SPACE_GLYPH : 12, fontWeight: "700", color: ink }}>{profile.icon ?? (profile.name.trim()[0] ?? "?").toUpperCase()}</Text>
            )}
          </Animated.View>
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

async function newSpace(windowId: string) {
  const id = await createProfile(windowId);
  if (id) switchProfile(windowId, id);
}

/** A space's menu (right-click on its icon): its name, icon and theme, its settings, and deleting it. */
export async function openSpaceMenu(windowId: string, id: string) {
  const s = useBrowser.getState();
  const space = s.profiles[id];
  if (!space) return;
  const choice = await showMenu([
    { id: "rename", title: "Rename Space…", symbol: "pencil" },
    { id: "iconMenu", title: "Change Icon", symbol: "face.smiling", children: iconMenuItems(space.icon) },
    {
      id: "themeMenu",
      title: "Theme",
      symbol: "paintpalette",
      children: [
        ...(Object.keys(PROFILE_COLORS) as ProfileColor[]).map((c) => ({ id: `theme:${c}`, title: PROFILE_COLORS[c].name, swatch: PROFILE_COLORS[c].swatch, checked: !space.theme && c === space.color })),
        { separator: true as const },
        { id: "editTheme", title: "Edit Theme…", symbol: "slider.horizontal.3", checked: !!space.theme },
      ],
    },
    { separator: true },
    { id: "settings", title: "Space Settings…", symbol: "gearshape" },
    { id: "delete", title: "Delete Space…", symbol: "trash", enabled: s.profileOrder.length > 1 },
  ]);
  const update = useBrowser.getState().updateProfile;
  if (choice === "rename") {
    const name = await prompt({ title: "Rename Space", value: space.name, placeholder: "Space name", confirmTitle: "Rename", windowId });
    if (name?.trim()) update(id, { name: name.trim() });
  } else if (choice?.startsWith("icon:")) update(id, { icon: choice.slice("icon:".length) || null });
  else if (choice?.startsWith("theme:")) update(id, { color: choice.slice("theme:".length) as ProfileColor, theme: null });
  else if (choice === "editTheme") openThemeEditor(windowId, id);
  else if (choice === "settings") openSettings("profiles", id);
  else if (choice === "delete") void deleteProfile(id, windowId);
}
