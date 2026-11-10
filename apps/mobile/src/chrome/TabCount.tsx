import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Text, View } from "react-native";

/** The number of open tabs, on the corner of the Tabs button. */
export function TabCount({ count }: { count: number }): JSX.Element | null {
  const foreground = useThemeColor("foreground");
  const background = useThemeColor("background");

  if (count < 2) return null;

  return (
    <View
      testID="tab-count"
      pointerEvents="none"
      className="absolute -right-1 -top-1 h-5 min-w-5 items-center justify-center rounded-full px-1"
      style={{ backgroundColor: foreground }}
    >
      <Text style={{ color: background, fontSize: 11, fontWeight: "700" }}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}
