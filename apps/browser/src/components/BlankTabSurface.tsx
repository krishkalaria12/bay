import { Pressable, View, shortcutLabel } from "@bay/platform";
import { Symbol } from "@bay/shell";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useTheme } from "../lib/theme";
import { useBrowser } from "../store/browser";
import { useWindowId } from "../store/hooks";
import { activeTabId } from "../store/model";
import { NewTabExtras } from "./ntp";
import { tourAnchorRef } from "./onboarding/tour/anchors";
import { themeEditorOpen } from "./profiles/ThemeEditor";
import { useHover } from "./primitives";

// Restored blank tabs and Back to New Tab retain their tab and history. Search lives in the window palette.
export function BlankTabSurface({ tabId, focused }: { tabId: string; focused: boolean }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { hovered, hoverProps } = useHover();
  const open = () => useBrowser.getState().openPanel(windowId, "");

  useEffect(() => {
    if (!focused) return;
    const state = useBrowser.getState();
    if (activeTabId(state, windowId) !== tabId || state.tabs[tabId]?.url || state.windowUi[windowId]?.panel.open || themeEditorOpen(windowId)) return;
    state.openPanel(windowId, "");
  }, [tabId, windowId, focused]);

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 20 }}>
        <Symbol name="plus" size={34} weight="light" color={theme.textTertiary} style={{ width: 48, height: 48 }} />
        <View ref={tourAnchorRef(windowId, "commandBar", true)} {...hoverProps}>
          <Pressable
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel="Open search"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              borderRadius: 12,
              paddingHorizontal: 16,
              paddingVertical: 10,
              backgroundColor: pressed ? theme.toolbarPressed : hovered ? theme.toolbarHover : undefined,
            })}
          >
            <Symbol name="magnifyingglass" size={14} color={theme.textSecondary} style={{ width: 18, height: 18 }} />
            <Text style={{ color: theme.textSecondary, fontSize: 14 }}>Open search</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 12, marginLeft: 10 }}>{shortcutLabel("⌘L")}</Text>
          </Pressable>
        </View>
      </View>
      <NewTabExtras size={size} />
    </View>
  );
}
