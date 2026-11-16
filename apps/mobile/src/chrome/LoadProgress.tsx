import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { SETTLE, useReducedMotion } from "./motion";

/** How far in from the capsule's ends the line sits, so it stays on the pill's curve. */
const INSET = 24;

export interface LoadProgressProps {
  /** How far the page has loaded, from 0 to 1. */
  progress: number;
  /** Whether the page is still loading. */
  loading: boolean;
}

/**
 * The thin line along the capsule's edge (A6): it fills as the page loads and fades away once the page is there.
 */
export function LoadProgress({ progress, loading }: LoadProgressProps): JSX.Element | null {
  const accent = useThemeColor("accent");
  const filled = useSharedValue(0);
  const shown = useSharedValue(0);
  // The line stays on the screen until its fade is over, so it never blinks out.
  const [visible, setVisible] = useState(loading);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (loading) {
      setVisible(true);
      shown.value = withTiming(1, { duration: 120 });
      // A load that starts at nothing would show no line at all, so it begins with a sliver.
      filled.value = withTiming(Math.max(progress, 0.04), { ...SETTLE, duration: reduced ? 0 : SETTLE.duration });

      return;
    }

    shown.value = withTiming(0, { duration: 220 }, (finished) => {
      if (finished) scheduleOnRN(setVisible, false);
    });
  }, [filled, loading, progress, reduced, shown]);

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scaleX: filled.value }],
  }));

  if (!visible) return null;

  // Only a sign that something is happening, drawn under the capsule, so readers skip it.
  return (
    <Animated.View
      testID="page-progress"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.line, { backgroundColor: accent }, style]}
    />
  );
}

const styles = StyleSheet.create({
  line: {
    position: "absolute",
    left: INSET,
    right: INSET,
    bottom: 2,
    height: 2,
    borderRadius: 1,
    // The line grows from the capsule's left end, not from its middle.
    transformOrigin: "left center",
  },
});
