import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";

import type { CapsuleStyle } from "@/chrome/BrowserBar.types";

const DISTANCE = 64;
const VELOCITY = 600;

/** How far the capsule slides out, and in from the other side, when the tab changes. */
const SLIDE = 56;
const SPRING = { damping: 18, stiffness: 240, mass: 0.8 };

/** Two tabs on the same site show the same capsule, so nothing changes to wait for: slide in after this long. */
const ENTER_FALLBACK_MS = 250;

/**
 * Arc Search's bar swipe: drag the bottom bar sideways to go to the previous (right) or next (left) tab. The search
 * capsule follows the finger (rubbery where there's no tab to go to); on a switch it slides out that way and the new
 * tab's capsule springs in from the other side. `children` gets the capsule's style; the round buttons stay put.
 */
export function TabSwipe({
  onSwipe,
  hasPrevious,
  hasNext,
  contentKey,
  children,
}: {
  onSwipe: (step: 1 | -1) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  /** What the capsule shows (the site): the new tab's capsule slides in once this changes, never with the old text. */
  contentKey: string;
  children: (capsuleStyle: CapsuleStyle) => ReactNode;
}): JSX.Element {
  const offset = useSharedValue(0);
  const opacity = useSharedValue(1);
  // Read inside the gesture's worklets, which keep the values they were created with.
  const edges = useSharedValue({ previous: hasPrevious, next: hasNext });
  useEffect(() => {
    edges.value = { previous: hasPrevious, next: hasNext };
  }, [edges, hasPrevious, hasNext]);

  // After a switch the capsule waits off to one side, hidden, for the new tab's text.
  const entering = useRef<{ from: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  function enter(): void {
    const pending = entering.current;

    if (!pending) return;
    clearTimeout(pending.timer);
    entering.current = null;
    // On the UI thread, so the spring starts from the far side and not from where the capsule slid out.
    scheduleOnUI((from: number) => {
      "worklet";
      offset.value = from;
      offset.value = withSpring(0, SPRING);
      opacity.value = withTiming(1, { duration: 180 });
    }, pending.from);
  }

  function switched(step: 1 | -1, from: number): void {
    if (entering.current) clearTimeout(entering.current.timer);
    entering.current = { from, timer: setTimeout(enter, ENTER_FALLBACK_MS) };
    onSwipe(step);
  }

  // Runs once React has drawn the new text.
  useEffect(enter, [contentKey]);
  useEffect(
    () => () => {
      if (entering.current) clearTimeout(entering.current.timer);
    },
    [],
  );

  const pan = usePanGesture({
    // Horizontal only: vertical drags and taps go to the buttons and the page.
    activeOffsetX: [-16, 16],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      "worklet";
      const x = event.translationX;
      const open = x < 0 ? edges.value.next : edges.value.previous;
      offset.value = x * (open ? 0.4 : 0.12);
      // Fades as it nears the round buttons (16 points away), so it never covers them.
      opacity.value = 1 - Math.min(Math.abs(offset.value) / 110, 0.6);
    },
    onDeactivate: (event) => {
      "worklet";
      const { translationX: distance, velocityX: velocity } = event;
      let step: 1 | -1 | 0 = 0;

      if (!event.canceled) {
        if ((distance <= -DISTANCE || velocity <= -VELOCITY) && edges.value.next) step = 1;
        else if ((distance >= DISTANCE || velocity >= VELOCITY) && edges.value.previous) step = -1;
      }

      if (step === 0) {
        offset.value = withSpring(0, SPRING);
        opacity.value = withTiming(1, { duration: 160 });

        return;
      }

      // Next tab: out to the left, in from the right; previous: the other way round.
      const direction = step === 1 ? -1 : 1;
      opacity.value = withTiming(0, { duration: 110 });
      offset.value = withTiming(direction * SLIDE, { duration: 120, easing: Easing.in(Easing.quad) }, (finished) => {
        if (!finished) return;
        scheduleOnRN(switched, step, -direction * SLIDE * 0.8);
      });
    },
  });

  const capsuleStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: offset.value }, { scale: 1 - Math.min(Math.abs(offset.value) / 1600, 0.04) }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View testID="tab-swipe">{children(capsuleStyle)}</Animated.View>
    </GestureDetector>
  );
}
