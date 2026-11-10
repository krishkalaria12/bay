import type { JSX, ReactNode } from "react";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";

const SWIPE = 40;
const VELOCITY = 500;

/**
 * A short upward drag on a control, without taking its taps or a horizontal swipe: Arc's drag up on Tabs returns to
 * the last tab. Horizontal movement fails this gesture first, leaving it to the bar's tab swipe.
 */
export function SwipeUp({ onSwipeUp, children }: { onSwipeUp?: () => void; children: ReactNode }): JSX.Element {
  const pan = usePanGesture({
    enabled: Boolean(onSwipeUp),
    // Only upward movement activates; sideways movement fails, so the bar's tab swipe still gets it.
    activeOffsetY: [-12, 10_000],
    failOffsetX: [-24, 24],
    onDeactivate: (event) => {
      "worklet";

      if (!onSwipeUp || event.canceled) return;

      if (event.translationY <= -SWIPE || event.velocityY <= -VELOCITY) scheduleOnRN(onSwipeUp);
    },
  });

  return <GestureDetector gesture={pan}>{children}</GestureDetector>;
}
