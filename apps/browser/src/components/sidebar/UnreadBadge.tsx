import { Text, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { unreadFromTitle, unreadLabel } from "../../lib/unreadBadges";
import { useBrowser } from "../../store/browser";
import { UNREAD_BADGE_RED } from "./constants";

/** A favorite's unread count (or dot) from its page's title, in the tile's top corner, as Arc's Favorites had it. */
export function UnreadBadge({ tabId, corner }: { tabId: string; corner: "left" | "right" }) {
  const theme = useTheme();
  // The label ("" for a dot), not the parse: the selector runs on every store change, and a string compares by value.
  const label = useBrowser((s) => {
    const tab = s.tabs[tabId];
    if (!tab || !s.settings.unreadBadges) return null;
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
