import { Surface, Symbol } from "@bay/shell";
import { Pressable, Text, View } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { useHover } from "../primitives";
import { SpaceGlyph } from "../spaces/SpaceGlyph";
import { openSpaceMenu, renameSpace } from "../spaces/SpaceSwitcher";
import { useSidebarTokens, withAlpha } from "./tokens";

/** Arc's and yab's space title, above the Pinned section: the space's icon and name, and its menu behind "…" (the only way to it). */
export function SpaceTitle({ windowId, spaceId }: { windowId: string; spaceId: string }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const name = useBrowser((s) => s.spaces[spaceId]?.name);
  const { hovered, hoverProps } = useHover();
  if (name === undefined) return null;
  const menu = () => void openSpaceMenu(windowId, spaceId);

  return (
    <View {...hoverProps} onDoubleClick={() => void renameSpace(windowId, spaceId)}>
      <Surface
        fill={hex(hovered ? theme.tabHover : "rgba(0,0,0,0)")}
        cornerRadius={10}
        style={{ height: layout.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 4, gap: 7 }}
      >
        <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
          <SpaceGlyph spaceId={spaceId} size={14} />
        </View>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
          {name}
        </Text>
        {hovered ? (
          <Pressable onPress={menu} accessibilityLabel={`${name} menu`} tooltip="Space menu">
            {({ pressed }) => (
              <View
                style={{
                  width: 26,
                  height: 22,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.tabPressed : withAlpha(tokens.groupTitle, 0.12),
                }}
              >
                <Symbol name="ellipsis" size={12} weight="semibold" color={theme.textSecondary} style={{ width: 16, height: 16 }} />
              </View>
            )}
          </Pressable>
        ) : null}
      </Surface>
    </View>
  );
}
