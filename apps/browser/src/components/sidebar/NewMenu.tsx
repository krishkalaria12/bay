import { Surface, Symbol } from "@bay/shell";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { newEasel, openLibrary } from "../library/actions";
import { createSpace, switchSpace } from "../../lib/actions";
import { hex, useTheme } from "../../lib/theme";
import { installUpdate, updateTitle, usePendingUpdate } from "../../lib/updates";
import { useBrowser } from "../../store/browser";
import { splitWithCurrentTab } from "../layout/splitActions";
import { useSidebarOnRight } from "../layout/windowLayout";
import { useHover } from "../primitives";
import { newPinnedFolderWith } from "./actions";
import { measureRow, setSidebarUi, useSidebarUi } from "./state";
import { NEW_MENU_ID, NEW_MENU_MS, NEW_MENU_WIDTH } from "./constants";

// yab's + at the sidebar's foot: not a system menu but a panel of its own, rising out of the + (which turns to ×),
// with icons by the things it makes and the shortcuts that make them.

type Item = { id: string; title: string; icon?: string; shortcut?: string } | "separator";

export async function openNewMenu(windowId: string) {
  if (useSidebarUi.getState().newMenu?.windowId === windowId) return closeNewMenu();
  const anchor = await measureRow(windowId, NEW_MENU_ID);
  setSidebarUi({ newMenu: { windowId, anchor }, hover: null });
}

// The panel's own close runs its fade first; this is for a second press of the + (the panel then goes at once).
const closers = new Map<string, () => void>();
export function closeNewMenu() {
  const menu = useSidebarUi.getState().newMenu;
  if (!menu) return;
  const close = closers.get(menu.windowId);
  if (close) close();
  else setSidebarUi({ newMenu: null });
}

async function newSpace(windowId: string) {
  const id = await createSpace(windowId);
  if (id) switchSpace(windowId, id);
}

function run(windowId: string, id: string) {
  if (id === "update") installUpdate();
  else if (id === "easel") newEasel(windowId);
  else if (id === "library") openLibrary(windowId);
  else if (id === "space") void newSpace(windowId);
  else if (id === "folder") newPinnedFolderWith(windowId);
  else if (id === "split") splitWithCurrentTab(windowId);
  else if (id === "tab") useBrowser.getState().openNewTabPanel(windowId);
}

export function NewMenu({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const menu = useSidebarUi((u) => (u.newMenu?.windowId === windowId ? u.newMenu : null));
  return menu ? <Panel windowId={windowId} anchor={menu.anchor} windowWidth={windowWidth} windowHeight={windowHeight} /> : null;
}

function Panel({
  windowId,
  anchor,
  windowWidth,
  windowHeight,
}: {
  windowId: string;
  anchor: { x: number; y: number; width: number; height: number } | null;
  windowWidth: number;
  windowHeight: number;
}) {
  const theme = useTheme();
  const pending = usePendingUpdate((u) => u.pending);
  const right = useSidebarOnRight();
  const shown = useSharedValue(0);
  const closing = useRef(false);
  useEffect(() => shown.set(withTiming(1, { duration: NEW_MENU_MS, easing: Easing.out(Easing.cubic) })), []);
  const close = (then?: () => void) => {
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      setSidebarUi({ newMenu: null });
      then?.();
    };
    shown.set(withTiming(0, { duration: NEW_MENU_MS * 0.7, easing: Easing.in(Easing.cubic) }, (finished) => finished && runOnJS(done)()));
  };
  useEffect(() => {
    closers.set(windowId, () => close());
    return () => void closers.delete(windowId);
  });
  // Rises out of the +: up from below it, growing from its corner.
  const style = useAnimatedStyle(() => {
    const p = shown.get();
    return { opacity: p, transform: [{ translateY: (1 - p) * 10 }, { translateX: (1 - p) * (right ? 8 : -8) }, { scale: 0.94 + p * 0.06 }] };
  });

  const items: Item[] = [
    // A downloading update has nothing to press yet: the sidebar's row shows it.
    ...(pending && !pending.downloading
      ? [{ id: "update", title: `${updateTitle(pending)} (${pending.version})`, icon: "arrow.down.circle" }, "separator" as const]
      : []),
    { id: "space", title: "New Space", icon: "plus.square.on.square" },
    { id: "easel", title: "New Easel", icon: "scribble.variable", shortcut: "⌃⇧E" },
    { id: "library", title: "Library", icon: "books.vertical" },
    { id: "folder", title: "New Folder", icon: "folder.badge.plus" },
    "separator",
    { id: "split", title: "Split View", icon: "rectangle.split.2x1", shortcut: "⌃⇧=" },
    { id: "tab", title: "New Tab", icon: "plus", shortcut: "⌘T" },
  ];
  // Just above the +, starting at it and reaching over the page (from its right edge toward the page when the
  // sidebar is on the right), inside the window.
  const x = anchor ? (right ? anchor.x + anchor.width - NEW_MENU_WIDTH + 6 : anchor.x - 6) : 8;
  const left = Math.max(8, Math.min(windowWidth - NEW_MENU_WIDTH - 8, x));
  const bottom = anchor ? Math.max(8, windowHeight - anchor.y + 6) : 52;

  return (
    <>
      <Pressable onPress={() => close()} style={StyleSheet.absoluteFill} />
      <Animated.View style={[{ position: "absolute", left, bottom, width: NEW_MENU_WIDTH }, style]}>
        <Surface
          fill={hex(theme.panel)}
          cornerRadius={14}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={24}
          shadowOffset={[0, 10]}
          style={{ padding: 5 }}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <View
                key={`sep${i}`}
                style={{ height: 1, marginVertical: 4, marginHorizontal: 10, backgroundColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" }}
              />
            ) : (
              <Row key={item.id} item={item} onPress={() => close(() => run(windowId, item.id))} />
            ),
          )}
        </Surface>
      </Animated.View>
    </>
  );
}

function Row({ item, onPress }: { item: Exclude<Item, "separator">; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="menuitem" accessibilityLabel={item.title}>
        {({ pressed }) => (
          <View
            style={{
              height: 30,
              borderRadius: 8,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 8,
              gap: 8,
              backgroundColor: pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
            }}
          >
            <View style={{ width: 18, alignItems: "center" }}>
              {item.icon ? <Symbol name={item.icon} size={14} color={theme.textPrimary} style={{ width: 18, height: 18 }} /> : null}
            </View>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textPrimary }}>
              {item.title}
            </Text>
            {item.shortcut ? <Text style={{ fontSize: 12, color: theme.textTertiary, letterSpacing: 1 }}>{item.shortcut}</Text> : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}
