import { useThemeColor } from "heroui-native";
import { useEffect, type JSX } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import type { ToggleProps } from "./Toggle.types";

// A flat switch (no Material thumb shadow or ripple). The row around it handles the tap.
export function Toggle({ value, disabled }: ToggleProps): JSX.Element {
  const accent = useThemeColor("accent");
  const on = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    on.value = withTiming(value ? 1 : 0, { duration: 160 });
  }, [value, on]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * 18 }] }));

  return (
    <View
      pointerEvents="none"
      className="bg-foreground/20"
      style={[{ width: 44, height: 26, borderRadius: 13, padding: 3, opacity: disabled ? 0.4 : 1 }, value && { backgroundColor: accent }]}
    >
      <Animated.View style={[{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#FFFFFF" }, thumb]} />
    </View>
  );
}
