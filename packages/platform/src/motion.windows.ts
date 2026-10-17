import { useEffect, useLayoutEffect, useSyncExternalStore, useRef, type ComponentType } from "react";
import { AccessibilityInfo, Easing, Image, ScrollView, Text, processColor, type ViewStyle, type TextStyle, type ImageStyle } from "react-native";
import { View } from "./views";
import { cancelAnimation, collectMotion, configureMotionClock, interpolate, makeMutable, type SharedValue } from "./motion-runtime";
export * from "./motion-runtime";
export { Easing };
export type WithTimingConfig = import("./motion-runtime").TimingConfig;

let reduced = false;
void AccessibilityInfo.isReduceMotionEnabled().then(
  (value) => {
    reduced = value;
  },
  () => {},
);
AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
  reduced = value;
});
configureMotionClock({
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  reduced: () => reduced,
});

export function useSharedValue<T>(initial: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  ref.current ??= makeMutable(initial);
  const value = ref.current;
  useEffect(() => () => cancelAnimation(value), [value]);
  return value;
}

/** Shared-value reads subscribe the component; updates use ordinary RNW styles. */
export function useAnimatedStyle<T extends ViewStyle | TextStyle | ImageStyle>(updater: () => T, _dependencies?: readonly unknown[]): T {
  const result = collectMotion(updater);
  const snapshot = () => {
    let version = 0;
    for (const dependency of result.dependencies) version = Math.max(version, dependency.version());
    return version;
  };
  useSyncExternalStore(
    (notify) => {
      const cleanups = [...result.dependencies].map((value) => value.subscribe(notify));
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    },
    snapshot,
    snapshot,
  );
  return result.value;
}

export function useAnimatedReaction<T>(prepare: () => T, react: (value: T, previous: T | null) => void, _dependencies?: readonly unknown[]): void {
  const previous = useRef<T | null>(null);
  useLayoutEffect(() => {
    let cleanups: (() => void)[] = [];
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      try {
        for (const cleanup of cleanups) cleanup();
        const result = collectMotion(prepare);
        cleanups = [...result.dependencies].map((value) => value.subscribe(run));
        if (!Object.is(previous.current, result.value)) {
          const old = previous.current;
          previous.current = result.value;
          react(result.value, old);
        }
      } finally {
        running = false;
      }
    };
    run();
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });
}

export function runOnJS<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  return callback;
}
export function useEvent<T>(handler: (event: T) => void, _eventNames?: string[], _rebuild?: boolean): (event: T | { nativeEvent: T }) => void {
  return (event) => handler(event && typeof event === "object" && "nativeEvent" in event ? event.nativeEvent : (event as T));
}
export function useAnimatedScrollHandler(handler: (event: { contentOffset: { x: number; y: number } }) => void) {
  return useEvent(handler);
}

export function interpolateColor(value: number, input: number[], colors: string[], _space?: string): string {
  const channels = colors.map((color) => {
    const processed = processColor(color);
    if (typeof processed !== "number") throw new Error(`Windows motion needs a static color: ${color}`);
    return [(processed >>> 16) & 255, (processed >>> 8) & 255, processed & 255, (processed >>> 24) / 255];
  });
  const component = (index: number) =>
    interpolate(
      value,
      input,
      channels.map((color) => color[index]!),
      "clamp",
    );
  return `rgba(${Math.round(component(0))}, ${Math.round(component(1))}, ${Math.round(component(2))}, ${component(3)})`;
}

// Styles already hold numbers, so these are standard RN components with normal accessibility/ref behavior.
const Animated = { View, Text, Image, ScrollView, createAnimatedComponent: <T extends ComponentType<any>>(component: T): T => component };
export default Animated;
