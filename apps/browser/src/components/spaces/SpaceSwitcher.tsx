import { Pressable, View } from "@bay/platform";
import { showMenu, Symbol } from "@bay/desktop";
import { useEffect } from "react";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "@bay/platform/motion";
import { useShallow } from "zustand/react/shallow";
import { deleteSpace, switchSpace } from "../../lib/actions";
import { layout } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { usePagerOpacity, usePagerPages, type PagerPage } from "./pager";
import { useHover } from "../ui/primitives";
import { openSettings } from "../settings/windows";
import { useTabsSidebarWidth } from "../sidebar/tokens";
import { newPinnedFolderWith, openIconPicker } from "../sidebar/actions";
import { openNewMenu } from "../sidebar/NewMenu";
import { NEW_MENU_ID, NEW_MENU_MS } from "../sidebar/constants";
import { registerRow, useSidebarUi } from "../sidebar/state";
import { SpaceGlyph } from "./SpaceGlyph";
import { requestRename } from "../ui/RenameDialog";
import { newLiveFolderMenuItem, runNewLiveFolder } from "../sidebar/activityFolderMenus";
import { openThemeEditor } from "./ThemeEditor";
import { useSpaceDrag, useSpaceReorder, type SpaceReorder } from "./reorder";
import { cellWidths, centres, iconWindow, ICON_SLOT } from "./spaceRow";
import {
  DOT_HOVERED_OPACITY,
  DOT_IDLE_OPACITY,
  DOT_SELECTED_OPACITY,
  DOTS_CELL,
  DOTS_DOT,
  PROFILE_DOTS_HEIGHT,
  SPACE_CELL,
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

// Each icon selects a space with its own browsing profile. When they don't all fit, the current space and its
// neighbours keep their icons and the rest are dots (spaceRow.ts); moving between spaces moves the icons along.
const GROW = { duration: 220, easing: Easing.out(Easing.cubic) };

export function SpaceSwitcher({ windowId }: { windowId: string }) {
  const ids = useBrowser(useShallow((s) => s.spaceOrder));
  const current = useBrowser((s) => s.windows[windowId]?.spaceId ?? "");
  const width = useTabsSidebarWidth(windowId);
  const { pages } = usePagerPages(windowId);
  const icons = iconWindow(ids.length, ids.indexOf(current), width - 2 * (layout.sidebarInset + SPACE_SIDE));
  const { reorder, dragging } = useSpaceReorder(() => centres(cellWidths(icons)));

  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT }}>
      <View style={{ height: PROFILE_DOTS_HEIGHT - 3, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
        {ids.map((id, i) => (
          <SpaceCell key={id} id={id} windowId={windowId} page={pages.find((p) => p.id === id)} icon={icons[i]!} reorder={reorder} lifted={dragging === id} />
        ))}
      </View>
      <View style={{ position: "absolute", right: layout.sidebarInset, top: (PROFILE_DOTS_HEIGHT - 3 - SPACE_PLUS) / 2 }}>
        <NewButton windowId={windowId} />
      </View>
    </View>
  );
}

// A space's icon or its dot, growing from one into the other as the current space moves. Dragged along the row, it
// reorders the spaces (Arc).
function SpaceCell({
  id,
  windowId,
  page,
  icon,
  reorder,
  lifted,
}: {
  id: string;
  windowId: string;
  page: PagerPage | undefined;
  icon: boolean;
  reorder: SpaceReorder;
  lifted: boolean;
}) {
  const theme = useTheme();
  const name = useBrowser((s) => s.spaces[id]?.name);
  const { hovered, hoverProps } = useHover();
  const lit = hovered || lifted;
  const iconOpacity = usePagerOpacity(windowId, page?.slot, lit ? SPACE_HOVERED_OPACITY : SPACE_IDLE_OPACITY, SPACE_SELECTED_OPACITY);
  const dotOpacity = usePagerOpacity(windowId, page?.slot, lit ? DOT_HOVERED_OPACITY : DOT_IDLE_OPACITY, DOT_SELECTED_OPACITY);
  const panHandlers = useSpaceDrag(reorder, id, "x");
  const offset = reorder.offsetOf(id);
  const grown = useSharedValue(icon ? 1 : 0);
  useEffect(() => grown.set(withTiming(icon ? 1 : 0, GROW)), [icon]);

  const cellStyle = useAnimatedStyle(
    () => ({
      width: DOTS_CELL + (ICON_SLOT - DOTS_CELL) * grown.get(),
      transform: [{ translateX: offset.get() }, { scale: lifted ? SPACE_LIFTED_SCALE : 1 }],
    }),
    [offset, lifted],
  );

  const glyphStyle = useAnimatedStyle(() => ({ opacity: grown.get(), transform: [{ scale: 0.4 + 0.6 * grown.get() }] }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: 1 - grown.get(), transform: [{ scale: 1 + grown.get() }] }));

  if (name === undefined) return null;

  return (
    <Animated.View {...panHandlers} style={[{ zIndex: lifted ? 1 : 0, height: SPACE_CELL }, cellStyle]}>
      <View ref={(v) => registerRow(windowId, id, v)} {...hoverProps} tooltip={lifted ? undefined : name} style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={() => switchSpace(windowId, id, true)} style={{ flex: 1 }}>
          <View pointerEvents="none" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Animated.View style={[{ position: "absolute" }, dotStyle]}>
              <Animated.View
                style={[{ width: DOTS_DOT, height: DOTS_DOT, borderRadius: DOTS_DOT / 2, backgroundColor: theme.dark ? "#FFFFFF" : "#000000" }, dotOpacity]}
              />
            </Animated.View>
            <Animated.View
              style={[{ position: "absolute", width: SPACE_CELL, height: SPACE_CELL, alignItems: "center", justifyContent: "center" }, glyphStyle]}
            >
              <Animated.View style={iconOpacity}>
                <SpaceGlyph spaceId={id} size={SPACE_GLYPH} />
              </Animated.View>
            </Animated.View>
          </View>
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
    // SAFETY: View | null)} style assertion matches the runtime value validated at this call site.
    <Animated.View ref={(v) => registerRow(windowId, NEW_MENU_ID, v as View | null)} style={style}>
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
    { id: "look", title: "Edit Theme…", symbol: "paintpalette" },
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
