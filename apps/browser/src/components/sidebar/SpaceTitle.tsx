import { Pressable, View } from "@bay/platform";
import { ContextMenuArea, Surface, Symbol } from "@bay/shell";
import { Text } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useHover } from "../primitives";
import { SpaceGlyph } from "../spaces/SpaceGlyph";
import { openSpaceMenu } from "../spaces/SpaceSwitcher";
import { useSidebarMetrics, useSidebarTokens, withAlpha } from "./tokens";

/** The title folds the pinned section; its menu lives on the ellipsis and right-click. */
export function SpaceTitle({ windowId, spaceId }: { windowId: string; spaceId: string }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const metrics = useSidebarMetrics();
  const name = useBrowser((s) => s.spaces[spaceId]?.name);
  const folded = useBrowser((s) => !!s.spaces[spaceId]?.folded);
  const { hovered, hoverProps } = useHover();
  if (name === undefined) return null;
  const menu = () => void openSpaceMenu(windowId, spaceId);

  return (
    <View {...hoverProps}>
      <ContextMenuArea onContextMenu={menu}>
        <Surface
          fill={hex(hovered ? theme.tabHover : "rgba(0,0,0,0)")}
          cornerRadius={10}
          style={{ height: metrics.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 4, gap: 7 }}
        >
          <Pressable
            onPress={() => useBrowser.getState().updateSpace(spaceId, { folded: !useBrowser.getState().spaces[spaceId]?.folded })}
            accessibilityLabel={`${folded ? "Expand" : "Fold"} ${name}`}
            accessibilityState={{ expanded: !folded }}
            style={{ flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: 7 }}
          >
            <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
              <SpaceGlyph spaceId={spaceId} size={metrics.iconSize - 2} />
            </View>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
              {name}
            </Text>
            <Symbol name={folded ? "chevron.right" : "chevron.down"} size={9} color={theme.textSecondary} style={{ width: 12, height: 12 }} />
          </Pressable>
          <Pressable onPress={menu} accessibilityLabel={`${name} menu`} tooltip="Space menu">
            {({ pressed }) => (
              <View
                style={{
                  width: 26,
                  height: 22,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.tabPressed : hovered ? withAlpha(tokens.groupTitle, 0.12) : "transparent",
                }}
              >
                <Symbol name="ellipsis" size={12} weight="semibold" color={theme.textSecondary} style={{ width: 16, height: 16 }} />
              </View>
            )}
          </Pressable>
        </Surface>
      </ContextMenuArea>
    </View>
  );
}
