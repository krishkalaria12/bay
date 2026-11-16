import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";
import { Text } from "./Text";

/** The number of open tabs, on the corner of the Tabs button. The button's own label says the count, so readers skip the badge. */
export function TabCount({ count }: { count: number }): JSX.Element | null {
  const foreground = useThemeColor("foreground");
  const background = useThemeColor("background");

  if (count < 2) return null;

  return (
    <View
      testID="tab-count"
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute -right-1 -top-1 h-5 min-w-5 items-center justify-center rounded-full px-1"
      style={{ backgroundColor: foreground }}
    >
      <Text variant="micro" weight="bold" color={background}>
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  );
}
