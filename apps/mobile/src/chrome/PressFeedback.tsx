import type { JSX, ReactNode } from "react";
import { Pressable, StyleSheet, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type BaseAnimationBuilder,
  type EntryOrExitLayoutType,
  type LayoutAnimationFunction,
} from "react-native-reanimated";

import { TAP, useReducedMotion } from "./motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** How far a held control shrinks. */
const HELD_SCALE = 0.04;

/** How much a held control dims. */
const HELD_DIM = 0.12;

export interface PressFeedbackProps extends Omit<PressableProps, "style"> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Moves the control into place when the row around it changes (A5). */
  layout?: BaseAnimationBuilder | LayoutAnimationFunction;
  /** The fade the control makes when it arrives (A5). */
  entering?: EntryOrExitLayoutType;
  /** The fade the control makes when it leaves (A5). */
  exiting?: EntryOrExitLayoutType;
}

/**
 * The press feedback every tile and row shares (A4): the control shrinks a little and dims while it is held, then
 * eases back when it is released. With reduced motion the shrink is left out and only the dim stays, so the change is
 * still there without anything travelling.
 */
export function PressFeedback({ children, style, layout, entering, exiting, onPressIn, onPressOut, ...rest }: PressFeedbackProps): JSX.Element {
  const held = useSharedValue(0);
  const reduced = useReducedMotion();
  // A row that is turned off is already dim; the press only takes it a little further.
  const dimmed = StyleSheet.flatten(style)?.opacity ?? 1;

  const feedback = useAnimatedStyle(() => ({
    transform: reduced ? [] : [{ scale: 1 - held.value * HELD_SCALE }],
    opacity: dimmed * (1 - held.value * HELD_DIM),
  }));

  return (
    <AnimatedPressable
      {...rest}
      layout={layout}
      entering={entering}
      exiting={exiting}
      style={[style, feedback]}
      onPressIn={(event: GestureResponderEvent) => {
        held.value = withTiming(1, TAP);
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        held.value = withTiming(0, TAP);
        onPressOut?.(event);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}
