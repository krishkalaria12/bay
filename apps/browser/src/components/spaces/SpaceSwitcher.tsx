import { Pressable, View } from "@bay/platform";
import { showMenu, Symbol } from "@bay/shell";
import { useEffect } from "react";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "@bay/platform/motion";
import { useShallow } from "zustand/react/shallow";
import { deleteSpace, switchSpace } from "../../lib/actions";
import { layout } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { usePagerOpacity, usePagerPages, type PagerPage } from "../layout/spacePager";
import { useHover } from "../primitives";
import { openSettings } from "../settings/windows";
import { useSidebarWidth } from "../sidebar/tokens";
import { newPinnedFolderWith, openIconPicker } from "../sidebar/actions";
import { openNewMenu } from "../sidebar/NewMenu";
import { NEW_MENU_ID, NEW_MENU_MS } from "../sidebar/constants";
import { registerRow, useSidebarUi } from "../sidebar/state";
import { SpaceGlyph } from "./SpaceGlyph";
import { requestRename } from "../RenameDialog";
import { newLiveFolderMenuItem, runNewLiveFolder } from "../sidebar/liveMenus";
import { openThemeEditor } from "./ThemeEditor";
import { SpaceDots } from "./SpaceDots";
import { useSpaceDrag, useSpaceReorder, type SpaceReorder } from "./reorder";
import {
  PROFILE_DOTS_HEIGHT,
  SPACE_CELL,
  SPACE_GAP,
  SPACE_GLYPH,
  SPACE_HOVERED_OPACITY,
  SPACE_IDLE_OPACITY,
  SPACE_LIFTED_SCALE,
  SPACE_PLUS,
  SPACE_SELECTED_OPACITY,
  SPACE_SIDE,
} from "./constants";
import { reportBrowserCommand } from "../../runtime/commands";
import { updateSpace } from "../../runtime/spaceActions";

// Each icon selects a space with its own browsing profile. Dots replace icons once they no longer fit.

export function SpaceSwitcher({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.spaceOrder));
  const width = useSidebarWidth(windowId);
  const { pages } = usePagerPages(windowId);
  const fits = ids.length * SPACE_CELL + (ids.length - 1) * SPACE_GAP <= width - 2 * (layout.sidebarInset + SPACE_SIDE);
  const { reorder, dragging } = useSpaceReorder(SPACE_CELL + SPACE_GAP);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT }}>
      {fits ? (
        <View style={{ height: PROFILE_DOTS_HEIGHT - 3, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE_GAP }}>
          {ids.map((id) => (
            <SpaceIcon key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} reorder={reorder} lifted={dragging === id} />
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

// Dragged along the row, a space's icon reorders the spaces (Arc).
function SpaceIcon({
  id,
  windowId,
  page,
  reorder,
  lifted,
}: {
  id: string;
  windowId: string;
  page: PagerPage | undefined;
  reorder: SpaceReorder;
  lifted: boolean;
}) {
  const name = useBrowser((s) => s.spaces[id]?.name);
  const { hovered, hoverProps } = useHover();
  const opacity = usePagerOpacity(windowId, page?.slot, hovered || lifted ? SPACE_HOVERED_OPACITY : SPACE_IDLE_OPACITY, SPACE_SELECTED_OPACITY);
  const panHandlers = useSpaceDrag(reorder, id, "x");
  const offset = reorder.offsetOf(id);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }, { scale: lifted ? SPACE_LIFTED_SCALE : 1 }] }), [offset, lifted]);
  if (name === undefined) return null;
  return (
    <Animated.View {...panHandlers} style={[{ zIndex: lifted ? 1 : 0 }, dragStyle]}>
      <View ref={(v) => registerRow(windowId, id, v)} {...hoverProps} tooltip={lifted ? undefined : name}>
        <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={() => switchSpace(windowId, id, true)}>
          <Animated.View style={[{ width: SPACE_CELL, height: SPACE_CELL, borderRadius: 7, alignItems: "center", justifyContent: "center" }, opacity]}>
            <SpaceGlyph spaceId={id} size={SPACE_GLYPH} />
          </Animated.View>
        </Pressable>
      </View>
    </Animated.View>
  );
}

// The + that opens the menu of what can be made here, and turns to × while it's open.
function NewButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const open = useSidebarUi((u) => u.newMenu?.windowId === windowId);
  const turn = useSharedValue(0);
  useEffect(() => turn.set(withTiming(open ? 1 : 0, { duration: NEW_MENU_MS, easing: Easing.out(Easing.cubic) })), [open]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 45}deg` }] }));
  return (
    <Animated.View ref={(v) => registerRow(windowId, NEW_MENU_ID, v as unknown as View | null)} style={style}>
      {/* Just the +: no hover or press fill behind it, it turns to × instead. */}
      <Pressable onPress={() => void openNewMenu(windowId)} accessibilityRole="button" accessibilityLabel="New" tooltip={open ? undefined : "New"}>
        {({ pressed }) => (
          <View style={{ width: SPACE_PLUS, height: SPACE_PLUS, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 }}>
            <Symbol name="plus" size={14} color={theme.icon} style={{ width: SPACE_PLUS, height: SPACE_PLUS }} />
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

export { openNewMenu };

/** A space's menu from its title row's …, with customization, settings and deletion. */
export async function openSpaceMenu(windowId: string, id: string) {
  const s = useBrowser.getState();
  const space = s.spaces[id];
  if (!space) return;
  const choice = await showMenu([
    { id: "rename", title: "Rename…", symbol: "character.cursor.ibeam" },
    { id: "icon", title: "Change Icon…", symbol: "face.smiling" },
    { id: "look", title: "Edit Look…", symbol: "paintpalette" },
    { separator: true },
    { id: "newFolder", title: "New Folder", symbol: "folder.badge.plus" },
    newLiveFolderMenuItem(),
    { separator: true },
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
    reportBrowserCommand(newPinnedFolderWith(windowId));
  } else if (choice.startsWith("live:")) {
    here();
    runNewLiveFolder(windowId, choice);
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
  if (name) await updateSpace(id, { name });
}
