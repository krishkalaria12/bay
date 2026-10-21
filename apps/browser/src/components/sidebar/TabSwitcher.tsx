import { Pressable, View } from "@bay/platform";
import { FadeLabel, Surface } from "@bay/shell";
import { Text } from "react-native";
import { displayUrl } from "@bay/core";
import { hex, useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { tabTitle } from "./actions";
import { useSidebarUi } from "./state";
import { commitSwitcher, focusSwitcherRow } from "./switcher";
import { TabIcon } from "./TabIcon";
import { useSidebarTokens } from "./tokens";
import { SWITCHER_ROW, SWITCHER_WIDTH } from "./constants";

export function TabSwitcher({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const switcher = useSidebarUi((u) => (u.switcher?.windowId === windowId && u.switcher.visible ? u.switcher : null));
  if (!switcher) return null;
  const height = switcher.ids.length * SWITCHER_ROW + 16 + 26;
  return (
    <Surface
      fill={hex(theme.panel)}
      cornerRadius={16}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity}
      shadowRadius={28}
      shadowOffset={[0, 12]}
      style={{
        position: "absolute",
        left: (windowWidth - SWITCHER_WIDTH) / 2,
        top: Math.max(40, (windowHeight - height) / 2 - 40),
        width: SWITCHER_WIDTH,
        padding: 8,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textTertiary, paddingHorizontal: 8, paddingBottom: 6, paddingTop: 2 }}>Recent Tabs</Text>
      {switcher.ids.map((id, i) => (
        <SwitcherRow key={id} tabId={id} focused={i === switcher.index} index={i} focusFill={tokens.switcherFocus} outline={tokens.switcherOutline} />
      ))}
    </Surface>
  );
}

function SwitcherRow({ tabId, focused, index, focusFill, outline }: { tabId: string; focused: boolean; index: number; focusFill: string; outline: string }) {
  const theme = useTheme();
  const tab = useBrowser((s) => s.tabs[tabId]);
  if (!tab) return null;
  // Switch on mouse-down; the following mouse-up would close the switcher.
  return (
    <Pressable onPressIn={() => commitSwitcher(index)}>
      <View
        onMouseEnter={() => focusSwitcherRow(index)}
        style={{
          height: SWITCHER_ROW,
          borderRadius: 10,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 10,
          gap: 10,
          backgroundColor: focused ? focusFill : undefined,
          borderWidth: focused ? 0.5 : 0,
          borderColor: outline,
        }}
      >
        <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={18} spaceId={tab.spaceId} />
        <View style={{ flex: 1 }}>
          <FadeLabel text={tabTitle(tab)} fontSize={13} weight={focused ? "medium" : "regular"} color={theme.textPrimary} style={{ height: 17 }} />
          {tab.url ? <FadeLabel text={displayUrl(tab.url)} fontSize={11} color={theme.textSecondary} style={{ height: 14 }} /> : null}
        </View>
      </View>
    </Pressable>
  );
}
