import { DeviceMotion } from "expo-sensors";
import { useEffect } from "react";
import { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";

/** How the phone leans: -1 (left, or the top away) to 1 (right, or the top near). */
export interface Tilt {
  x: SharedValue<number>;
  y: SharedValue<number>;
}

/**
 * How the phone leans while the welcome is on screen, so its drawing moves a little with the hand: far things one way,
 * near things the other, the way a lens shifts. The way it's held when the welcome comes up is the middle, and the
 * middle follows a new way of holding it slowly. Off with reduced motion and where there's no motion sensor (the
 * simulator). Device motion asks no permission. After Yab's FirstRunTilt (Apache-2.0).
 */
export function useTilt(enabled: boolean): Tilt {
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  useEffect(() => {
    if (!enabled) return;
    let rest: { x: number; y: number } | null = null;
    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    void DeviceMotion.isAvailableAsync().then((available) => {
      if (!available || cancelled) return;
      DeviceMotion.setUpdateInterval(1000 / 60);
      subscription = DeviceMotion.addListener(({ accelerationIncludingGravity: gravity }) => {
        if (!gravity) return;
        // Gravity in g: the screen's sideways and upward axes.
        const gx = gravity.x / 9.81;
        const gy = gravity.y / 9.81;
        const middle = rest ?? { x: gx, y: gy };
        // A new way of holding it becomes the middle over a few seconds.
        middle.x += (gx - middle.x) * 0.012;
        middle.y += (gy - middle.y) * 0.012;
        rest = middle;
        // A quarter of a turn's gravity (about 15°) is the whole way; smoothed, so the hand's tremor never shows.
        const nx = Math.max(-1, Math.min(1, (gx - middle.x) / 0.26));
        const ny = Math.max(-1, Math.min(1, (gy - middle.y) / 0.26));
        x.value += (nx - x.value) * 0.16;
        y.value += (ny - y.value) * 0.16;
      });
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      x.value = 0;
      y.value = 0;
    };
  }, [enabled, x, y]);

  return { x, y };
}

/** A layer of the drawing at `depth`: positive comes toward the hand (moves with the lean), negative lies behind. */
export function useParallax(tilt: Tilt, depth: number) {
  return useAnimatedStyle(() => ({ transform: [{ translateX: tilt.x.value * depth }, { translateY: -tilt.y.value * depth }] }));
}
