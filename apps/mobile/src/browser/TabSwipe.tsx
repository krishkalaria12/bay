import type { JSX, ReactNode } from "react";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const DISTANCE = 64;
const VELOCITY = 600;

/** Arc Search's bar swipe: drag the bottom bar sideways to go to the previous (right) or next (left) tab. */
export function TabSwipe({ onSwipe, children }: { onSwipe: (step: 1 | -1) => void; children: ReactNode }): JSX.Element {
  const offset = useSharedValue(0);
  const pan = usePanGesture({
    // Horizontal only: vertical drags and taps go to the buttons and the page.
    activeOffsetX: [-16, 16],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      "worklet";
      offset.value = event.translationX * 0.35;
    },
    onDeactivate: (event) => {
      "worklet";
      offset.value = withTiming(0, { duration: 180 });
      if (event.canceled) return;
      const { translationX: distance, velocityX: velocity } = event;
      if (distance <= -DISTANCE || velocity <= -VELOCITY) scheduleOnRN(onSwipe, 1);
      else if (distance >= DISTANCE || velocity >= VELOCITY) scheduleOnRN(onSwipe, -1);
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View testID="tab-swipe" style={style}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
