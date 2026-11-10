import { View } from "@bay/platform";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { unreadFromTitle, unreadLabel } from "../../lib/unreadBadges";
import { useSettings, useTab } from "../../store/hooks";
import { UNREAD_BADGE_RED } from "./constants";

/** A favorite's unread count (or dot) from its page's title, in the tile's top corner, as Arc's Favorites had it. */
export function UnreadBadge({ tabId, corner }: { tabId: string; corner: "left" | "right" }) {
  const theme = useTheme();
  const enabled = useSettings((s) => s.unreadBadges);

  // Follow this tab and the setting, so other pages' progress never parses this title again.
  const label = useTab(tabId, (tab) => {
    if (!tab || !enabled) return null;
    const unread = unreadFromTitle(tab.url, tab.title);

    if (!unread) return null;

    return "count" in unread ? unreadLabel(unread.count) : "";
  });

  if (label === null) return null;
  const ring = { borderWidth: 1.5, borderColor: theme.dark ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.9)" };

  return (
    <View pointerEvents="none" accessibilityLabel={label ? `${label} unread` : "Unread"} style={{ position: "absolute", top: 2, [corner]: 2 }}>
      {label ? (
        <View
          style={{
            height: 15,
            minWidth: 15,
            paddingHorizontal: 4,
            borderRadius: 7.5,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: UNREAD_BADGE_RED,
            ...ring,
          }}
        >
          <Text style={{ fontSize: 9, lineHeight: 11, fontWeight: "700", fontVariant: ["tabular-nums"], color: "#FFFFFF" }}>{label}</Text>
        </View>
      ) : (
        <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: UNREAD_BADGE_RED, ...ring }} />
      )}
    </View>
  );
}
