import * as Haptics from "expo-haptics";
import { useState, type JSX, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import type { BarSpace } from "./BrowserBar.types";
import { Text } from "./Text";
import { radius, space } from "./tokens";

/** How long a finger rests on the spaces before sliding moves between them. */
const HOLD_MS = 220;

export interface SpaceScrubProps {
  spaces: readonly BarSpace[];
  /** Where the spaces sit inside the capsule: their left edge and how wide they run (what shows, when they scroll). */
  area: { left: number; width: number };
  onSelect: (id: string) => void;
  /** The wrapper's own layout in the bar (Android's capsule shrinks to fit it). */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * Hold the bar's spaces, then slide: the space under the finger shows, with a tick as each one comes and its name over
 * the capsule. Across spaces that scroll, the slide runs over all of them from one end of the capsule to the other. A
 * plain tap still goes to the space it lands on.
 */
export function SpaceScrub({ spaces, area, onSelect, style, children }: SpaceScrubProps): JSX.Element {
  const [label, setLabel] = useState<string | null>(null);
  const scrubbing = useSharedValue(0);
  const current = useSharedValue(-1);
  const count = spaces.length;

  function choose(index: number): void {
    const target = spaces[index];

    if (!target) return;
    void Haptics.selectionAsync().catch(() => {});
    setLabel(target.label);
    onSelect(target.id);
  }

  function end(): void {
    setLabel(null);
  }

  /** Shows the space under the finger, once per space it reaches. */
  const reach = (x: number) => {
    "worklet";
    const index = Math.min(count - 1, Math.max(0, Math.floor(((x - area.left) / Math.max(1, area.width)) * count)));

    if (index === current.get()) return;
    current.set(index);
    scheduleOnRN(choose, index);
  };

  const scrub = usePanGesture({
    activateAfterLongPress: HOLD_MS,
    enabled: count > 1,
    onActivate: (event) => {
      "worklet";
      scrubbing.set(withTiming(1, { duration: 140 }));
      reach(event.x);
    },
    onUpdate: (event) => {
      "worklet";
      reach(event.x);
    },
    onFinalize: () => {
      "worklet";
      scrubbing.set(withTiming(0, { duration: 160 }));
      current.set(-1);
      scheduleOnRN(end);
    },
  });

  const grown = useAnimatedStyle(() => ({ transform: [{ scale: 1 + scrubbing.get() * 0.06 }] }));

  return (
    <GestureDetector gesture={scrub}>
      <Animated.View style={[style, grown]}>
        {label ? (
          <View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ bottom: "100%", marginBottom: space.sm }}>
            <View
              testID="bar-space-scrub-label"
              className="border border-black/10 bg-white/95 dark:border-white/10 dark:bg-neutral-900/95"
              style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.control }}
            >
              <Text variant="footnote" weight="semibold" numberOfLines={1}>
                {label}
              </Text>
            </View>
          </View>
        ) : null}
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
