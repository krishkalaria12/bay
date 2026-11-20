import { useState, type JSX, type ReactNode } from "react";
import { Pressable, StyleSheet, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  cubicBezier,
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

/** The tap's ease out (motion.ts's TAP: a cubic ease-out), for the transition a control eases by. */
const TAP_EASE = cubicBezier(0.33, 1, 0.68, 1);

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
 *
 * A control eases by a CSS transition the UI thread runs on its own, so a sheet of rows mounts no animation worklet per
 * row (each took a few milliseconds to set up, and a sheet holds dozens). One that moves into place when its row
 * changes (`layout`, `entering`, `exiting`) keeps the worklet, which those animations need beside it.
 */
export function PressFeedback(props: PressFeedbackProps): JSX.Element {
  return props.layout || props.entering || props.exiting ? <MovingPressFeedback {...props} /> : <EasedPressFeedback {...props} />;
}

/** A control whose hold eases by a transition on its style. */
function EasedPressFeedback({
  children,
  style,
  onPressIn,
  onPressOut,
  accessibilityRole = "button",
  accessibilityState,
  ...rest
}: PressFeedbackProps): JSX.Element {
  const [held, setHeld] = useState(false);
  const reduced = useReducedMotion();
  // A row that is turned off is already dim; the press only takes it a little further.
  const dimmed = StyleSheet.flatten(style)?.opacity ?? 1;

  return (
    <AnimatedPressable
      {...rest}
      // Every tile and row is a control, and a turned-off one says so to VoiceOver and TalkBack.
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled: Boolean(rest.disabled), ...accessibilityState }}
      style={[
        style,
        {
          opacity: dimmed * (held ? 1 - HELD_DIM : 1),
          transform: [{ scale: held && !reduced ? 1 - HELD_SCALE : 1 }],
          transitionProperty: ["opacity", "transform"],
          transitionDuration: TAP.duration,
          transitionTimingFunction: TAP_EASE,
        },
      ]}
      onPressIn={(event: GestureResponderEvent) => {
        setHeld(true);
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        setHeld(false);
        onPressOut?.(event);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}

/** A control that also moves into place when its row changes; its hold eases by a worklet beside those animations. */
function MovingPressFeedback({
  children,
  style,
  layout,
  entering,
  exiting,
  onPressIn,
  onPressOut,
  accessibilityRole = "button",
  accessibilityState,
  ...rest
}: PressFeedbackProps): JSX.Element {
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
      // Every tile and row is a control, and a turned-off one says so to VoiceOver and TalkBack.
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled: Boolean(rest.disabled), ...accessibilityState }}
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
