import { ContextMenuArea, prompt, showMenu, Symbol } from "@bay/shell";
import { Animated, Pressable, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { createProfile, deleteProfile, switchProfile } from "../../lib/actions";
import { layout, PROFILE_COLORS, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import type { ProfileColor } from "../../store/types";
import { usePagerPages, type PagerPage } from "../layout/profilePager";
import { IconButton, useHover } from "../primitives";
import { openSettings } from "../settings/windows";
import { useSidebarWidth } from "../sidebar/tokens";
import { iconMenuItems, profileSymbol } from "./icons";
import { PROFILE_DOTS_HEIGHT, ProfileDots } from "./ProfileDots";

// Arc's space switcher, at the foot of the sidebar: a space's icon each (Bay's profiles are Arc's spaces), the shown
// one at full strength as the pager moves, and + for a new space. Dots once the icons don't fit.
const CELL = 26;
const GLYPH = 15;
const PLUS = 28;
// Room kept on each side for + (right) and the footer's downloads button (left), so the icons stay centred.
const SIDE = PLUS + 4;
const SELECTED = 0.95;
const HOVERED = 0.6;
const IDLE = 0.38;

export function SpaceSwitcher({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.profileOrder));
  const width = useSidebarWidth(windowId);
  const { pages, pager } = usePagerPages(windowId);
  const fits = ids.length * CELL <= width - 2 * (layout.sidebarInset + SIDE);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT }}>
      {fits ? (
        <View style={{ height: PROFILE_DOTS_HEIGHT - 3, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          {ids.map((id) => (
            <SpaceIcon key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} pos={pager.pos} />
          ))}
        </View>
      ) : (
        <ProfileDots windowId={windowId} />
      )}
      <View style={{ position: "absolute", right: layout.sidebarInset, top: (PROFILE_DOTS_HEIGHT - 3 - PLUS) / 2 }}>
        <IconButton icon="plus" size={14} box={PLUS} radius={8} tooltip="New Space" onPress={() => void newSpace(windowId)} />
      </View>
    </View>
  );
}

function SpaceIcon({ id, windowId, page, pos }: { id: string; windowId: string; page: PagerPage | undefined; pos: Animated.Value }) {
  const theme = useTheme();
  const profile = useBrowser((s) => s.profiles[id]);
  const { hovered, hoverProps } = useHover();
  if (!profile) return null;
  const rest = hovered ? HOVERED : IDLE;
  const opacity = page
    ? pos.interpolate({ inputRange: [page.slot - 1, page.slot, page.slot + 1], outputRange: [rest, SELECTED, rest], extrapolate: "clamp" })
    : rest;
  const ink = theme.dark ? "#FFFFFF" : "#000000";
  const symbol = profileSymbol(profile.icon);
  return (
    <View {...hoverProps} tooltip={profile.name}>
      <ContextMenuArea onContextMenu={() => void openSpaceMenu(windowId, id)}>
        <Pressable accessibilityRole="button" accessibilityLabel={profile.name} onPress={() => switchProfile(windowId, id, true)}>
          <Animated.View style={{ width: CELL, height: CELL, borderRadius: 7, alignItems: "center", justifyContent: "center", opacity }}>
            {symbol ? (
              <Symbol name={symbol} size={GLYPH - 2} weight="semibold" color={ink} style={{ width: GLYPH + 2, height: GLYPH + 2 }} />
            ) : (
              <Text style={{ fontSize: profile.icon ? GLYPH : 12, fontWeight: "700", color: ink }}>{profile.icon ?? (profile.name.trim()[0] ?? "?").toUpperCase()}</Text>
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
      children: (Object.keys(PROFILE_COLORS) as ProfileColor[]).map((c) => ({ id: `theme:${c}`, title: PROFILE_COLORS[c].name, swatch: PROFILE_COLORS[c].swatch, checked: c === space.color })),
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
  else if (choice?.startsWith("theme:")) update(id, { color: choice.slice("theme:".length) as ProfileColor });
  else if (choice === "settings") openSettings("profiles", id);
  else if (choice === "delete") void deleteProfile(id, windowId);
}
