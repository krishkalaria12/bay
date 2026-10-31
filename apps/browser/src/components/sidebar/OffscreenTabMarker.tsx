import { Pressable, View } from "@bay/platform";
import { Symbol } from "@bay/shell";

import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { activeTabId } from "../../store/model";
import { TabIcon } from "./TabIcon";
import { useSidebarTokens } from "./tokens";
import { OFFSCREEN_MARKER_HEIGHT, OFFSCREEN_MARKER_INSET } from "./constants";

/**
 * The window's tab scrolled out of the sidebar's view, as Arc's overflow indicator: a small pill with its icon at the
 * edge it's beyond. Clicking it scrolls the tab back into view.
 */
export function OffscreenTabMarker({ windowId, side, top, onPress }: { windowId: string; side: "above" | "below"; top: number; onPress: () => void }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const tab = useBrowser((s) => {
    const id = activeTabId(s, windowId);
    return id ? s.tabs[id] : undefined;
  });
  if (!tab) return null;
  const label = tab.customTitle || tab.title || "Current tab";
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        alignItems: "center",
        ...(side === "above" ? { top: top + OFFSCREEN_MARKER_INSET } : { bottom: OFFSCREEN_MARKER_INSET }),
      }}
    >
      <Pressable accessibilityRole="button" accessibilityLabel={`Scroll to ${label}`} tooltip={`Scroll to ${label}`} onPress={onPress}>
        {({ pressed }) => (
          <View
            style={{
              height: OFFSCREEN_MARKER_HEIGHT,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 7,
              borderRadius: OFFSCREEN_MARKER_HEIGHT / 2,
              // Solid, over the rows it floats on.
              backgroundColor: theme.windowTint[0],
              opacity: pressed ? 0.7 : 1,
              borderWidth: 0.5,
              borderColor: tokens.separator,
              shadowColor: "#000000",
              shadowOpacity: theme.dark ? 0.35 : 0.12,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
            }}
          >
            <Symbol
              name={side === "above" ? "chevron.up" : "chevron.down"}
              size={8}
              weight="bold"
              color={theme.textSecondary}
              style={{ width: 10, height: 10 }}
            />
            <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={12} />
          </View>
        )}
      </Pressable>
    </View>
  );
}
