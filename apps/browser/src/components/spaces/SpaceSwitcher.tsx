import { showMenu } from "@bay/shell";
import { Pressable, View } from "react-native";
import { useEffect } from "react";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";
import { changeSpaceProfile, deleteSpace, switchSpace } from "../../lib/actions";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { usePagerOpacity, usePagerPages, type PagerPage } from "../layout/spacePager";
import { IconButton, useHover } from "../primitives";
import { openSettings } from "../settings/windows";
import { useSidebarWidth } from "../sidebar/tokens";
import { newPinnedFolderWith, openIconPicker } from "../sidebar/actions";
import { openNewMenu } from "../sidebar/NewMenu";
import { NEW_MENU_ID, NEW_MENU_MS } from "../sidebar/constants";
import { registerRow, useSidebarUi } from "../sidebar/state";
import { profileChoices } from "./CreateSpace";
import { SpaceGlyph } from "./SpaceGlyph";
import { requestRename } from "../RenameDialog";
import { newLiveFolderMenuItem, runNewLiveFolder } from "../sidebar/liveMenus";
import { openThemeEditor } from "./ThemeEditor";
import { SpaceDots } from "./SpaceDots";
import {
  PROFILE_DOTS_HEIGHT,
  SPACE_CELL,
  SPACE_GLYPH,
  SPACE_HOVERED_OPACITY,
  SPACE_IDLE_OPACITY,
  SPACE_PLUS,
  SPACE_SELECTED_OPACITY,
  SPACE_SIDE,
} from "./constants";

// Arc's space switcher, at the foot of the sidebar: a space's icon each (Bay's profiles are Arc's spaces), the shown
// one at full strength as the pager moves, and + for a new space. Dots once the icons don't fit.

export function SpaceSwitcher({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.spaceOrder));
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
        <SpaceDots windowId={windowId} />
      )}
      <View style={{ position: "absolute", right: layout.sidebarInset, top: (PROFILE_DOTS_HEIGHT - 3 - SPACE_PLUS) / 2 }}>
        <NewButton windowId={windowId} />
      </View>
    </View>
  );
}

function SpaceIcon({ id, windowId, page }: { id: string; windowId: string; page: PagerPage | undefined }) {
  const name = useBrowser((s) => s.spaces[id]?.name);
  const { hovered, hoverProps } = useHover();
  const opacity = usePagerOpacity(windowId, page?.slot, hovered ? SPACE_HOVERED_OPACITY : SPACE_IDLE_OPACITY, SPACE_SELECTED_OPACITY);
  if (name === undefined) return null;
  return (
    <View ref={(v) => registerRow(windowId, id, v)} {...hoverProps} tooltip={name}>
      <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={() => switchSpace(windowId, id, true)}>
        <Animated.View style={[{ width: SPACE_CELL, height: SPACE_CELL, borderRadius: 7, alignItems: "center", justifyContent: "center" }, opacity]}>
          <SpaceGlyph spaceId={id} size={SPACE_GLYPH} />
        </Animated.View>
      </Pressable>
    </View>
  );
}

// The + that opens the menu of what can be made here, and turns to × while it's open.
function NewButton({ windowId }: { windowId: string }) {
  const open = useSidebarUi((u) => u.newMenu?.windowId === windowId);
  const turn = useSharedValue(0);
  useEffect(() => turn.set(withTiming(open ? 1 : 0, { duration: NEW_MENU_MS, easing: Easing.out(Easing.cubic) })), [open]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 45}deg` }] }));
  return (
    <Animated.View ref={(v) => registerRow(windowId, NEW_MENU_ID, v as unknown as View | null)} style={style}>
      <IconButton icon="plus" size={14} box={SPACE_PLUS} radius={8} tooltip={open ? undefined : "New"} onPress={() => void openNewMenu(windowId)} />
    </Animated.View>
  );
}

export { openNewMenu };

/** A space's menu (only from its title row's …), in yab's order, then the space's profile and deleting it. */
export async function openSpaceMenu(windowId: string, id: string) {
  const s = useBrowser.getState();
  const space = s.spaces[id];
  if (!space) return;
  const profiles = profileChoices(s, id);
  const choice = await showMenu([
    { id: "rename", title: "Rename…", symbol: "character.cursor.ibeam" },
    { id: "icon", title: "Change Icon…", symbol: "face.smiling" },
    { id: "look", title: "Edit Look…", symbol: "paintpalette" },
    { separator: true },
    { id: "newFolder", title: "New Folder", symbol: "folder.badge.plus" },
    newLiveFolderMenuItem(),
    { separator: true },
    {
      id: "profileMenu",
      title: "Profile",
      symbol: "person.crop.circle",
      children: profiles.options.flatMap((o) => [
        ...(o.separatorBefore ? [{ separator: true as const }] : []),
        { id: `profile:${o.value}`, title: o.title, checked: o.value === profiles.value },
      ]),
    },
    { id: "settings", title: "Settings…", symbol: "gearshape" },
    { id: "delete", title: "Delete Space…", symbol: "trash", enabled: s.spaceOrder.length > 1 },
  ]);
  if (!choice) return;
  // A folder goes in the window's space: show this one first.
  const here = () => {
    if (useBrowser.getState().windows[windowId]?.spaceId !== id) switchSpace(windowId, id);
  };
  if (choice === "rename") void renameSpace(windowId, id);
  else if (choice === "icon") void openIconPicker(windowId, { kind: "space", id });
  else if (choice === "look") openThemeEditor(windowId, id);
  else if (choice === "newFolder") {
    here();
    newPinnedFolderWith(windowId);
  } else if (choice.startsWith("live:")) {
    here();
    runNewLiveFolder(windowId, choice);
  } else if (choice.startsWith("profile:") && choice !== `profile:${profiles.value}`) {
    const target = choice.slice("profile:".length);
    void changeSpaceProfile(id, target === "new" ? null : target, windowId);
  } else if (choice === "settings") openSettings("spaces", id);
  else if (choice === "delete") void deleteSpace(id, windowId);
}

export async function renameSpace(windowId: string, id: string) {
  const space = useBrowser.getState().spaces[id];
  if (!space) return;
  const name = await requestRename({
    windowId,
    title: `Rename ${space.name}`,
    value: space.name,
    placeholder: "Space name",
    icon: <SpaceGlyph spaceId={id} size={26} />,
  });
  if (name) useBrowser.getState().updateSpace(id, { name });
}
