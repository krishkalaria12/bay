import {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useReducedMotion,
  type BaseAnimationBuilder,
  type EntryOrExitLayoutType,
} from "react-native-reanimated";

import { openSpring, settleSpring, springConfig } from "./layout.ts";

/**
 * The spring Bay's motion settles with. Sheets, the switcher and the shared transitions all settle the same way, so the
 * app feels like one thing rather than a pile of screens. It is Arc Search's, as Cra fitted it to the footage: 0.34 s and
 * critically damped, so nothing overshoots where it was put. Springs are for what a finger moves (a drag, a card);
 * timings are for a tap.
 */
export const SPRING = springConfig(settleSpring);

/** A card growing into its page, or the search sheet into its place: quicker, still without overshoot. */
export const OPEN_SPRING = springConfig(openSpring);

/** A tap: quick, and eased out. */
export const TAP = { duration: 160, easing: Easing.out(Easing.cubic) } as const;

/** A change worth noticing, but not worth waiting for. */
export const SETTLE = { duration: 240, easing: Easing.out(Easing.cubic) } as const;

/** Whether the system asks for less motion. Every animation in Bay turns into a fade when it does. */
export { useReducedMotion };

/**
 * The layout shift a grid's items share (A5): when one of them is taken away, the rest close the gap instead of
 * jumping. With reduced motion the gap closes at once.
 */
export function gridShift(reduced: boolean): BaseAnimationBuilder {
  return LinearTransition.springify()
    .damping(SPRING.damping)
    .stiffness(SPRING.stiffness)
    .mass(SPRING.mass)
    .reduceMotion(reduced ? ReduceMotion.Always : ReduceMotion.System);
}

/** The fade a tile makes when it arrives (A5). */
export function tileArriving(): EntryOrExitLayoutType {
  return FadeIn.duration(200);
}

/** The fade a tile makes when it leaves (A5). */
export function tileLeaving(): EntryOrExitLayoutType {
  return FadeOut.duration(150);
}
