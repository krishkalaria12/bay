import { FadeLabel, Surface } from "@bay/shell";
import { Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { hex, useTheme } from "../../lib/theme";
import { layout, SYMBOL_PREFIX } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { groupLabel } from "../../store/organize";
import { tabTitle } from "./actions";
import { useTabDrag } from "../layout/tabDrag";
import type { Ghost } from "./dnd";
import { TabIcon } from "./TabIcon";
import { useSidebarTokens } from "./tokens";

export function DragGhost({ ghost }: { ghost: Ghost }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const { item, count, width, height, position } = ghost;
  const tab = useBrowser((s) => s.tabs[item.tabIds[0] ?? ""]);
  const folder = useBrowser((s) => (item.folderId ? s.pinnedFolders[item.folderId] : undefined));
  const label = useBrowser((s) => {
    const group = item.groupId ? s.groups[item.groupId] : undefined;
    if (group) return groupLabel(s, group);
    if (folder) return folder.name || "New Folder";
    return tab ? tabTitle(tab) : "";
  });
  const tile = item.kind === "tile";
  // Over the page the tab shows as the page's own card (SplitChrome.tsx).
  const onPage = useTabDrag((d) => d.onPage);
  const at = useAnimatedStyle(() => ({ transform: [{ translateX: position.x.get() }, { translateY: position.y.get() }] }), [position]);
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, width, height, opacity: onPage ? 0 : 1 }, at]}>
      <Surface
        fill={hex(tokens.dragSilhouette)}
        cornerRadius={10}
        borderColor={hex(tokens.dragBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.dark ? 0.45 : 0.18}
        shadowRadius={10}
        shadowOffset={[0, 4]}
        style={{
          width,
          height: tile ? layout.pinnedHeight : height,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: tile ? "center" : "flex-start",
          paddingLeft: tile ? 0 : 9,
          paddingRight: 6,
          opacity: 0.96,
        }}
      >
        {folder ? (
          <TabIcon url="" icon={folder.icon ?? `${SYMBOL_PREFIX}folder`} color={theme.textTab} />
        ) : tab ? (
          <TabIcon url={tab.url} favicon={tab.favicon} icon={item.kind === "group" ? null : tab.customIcon} profileId={tab.profileId} />
        ) : null}
        {!tile ? <FadeLabel text={label} fontSize={13} weight={item.kind === "group" || folder ? "medium" : "regular"} color={theme.textPrimary} style={{ flex: 1, height: 18, marginLeft: 7 }} /> : null}
      </Surface>
      {count > 1 ? (
        <View style={{ position: "absolute", top: -6, right: -4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: "#FFFFFF" }}>{count}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}
