// React Native Animated's springs as Reanimated withSpring configs, so a spring moved over keeps its feel: RN's own
// conversions (Animated/SpringConfig.js) from speed and bounciness, or tension and friction, to stiffness and damping.

const stiffnessFromOrigami = (tension: number) => (tension - 30) * 3.62 + 194;
const dampingFromOrigami = (friction: number) => (friction - 8) * 3 + 25;

/** Animated.spring's speed and bounciness (defaults 12 and 8). */
export function bouncySpring(speed = 12, bounciness = 8) {
  const normalize = (value: number, start: number, end: number) => (value - start) / (end - start);
  const project = (n: number, start: number, end: number) => start + n * (end - start);
  const quadOut = (t: number, start: number, end: number) => (2 * t - t * t) * end + (1 - (2 * t - t * t)) * start;
  // The friction that just stops a spring of this tension bouncing (RN's three fitted curves).
  const noBounce = (tension: number) => {
    if (tension <= 18) return 0.0007 * tension ** 3 - 0.031 * tension ** 2 + 0.64 * tension + 1.28;
    if (tension <= 44) return 0.000044 * tension ** 3 - 0.006 * tension ** 2 + 0.36 * tension + 2;
    return 0.00000045 * tension ** 3 - 0.000332 * tension ** 2 + 0.1078 * tension + 5.84;
  };
  const b = project(normalize(bounciness / 1.7, 0, 20), 0, 0.8);
  const tension = project(normalize(speed / 1.7, 0, 20), 0.5, 200);
  return { stiffness: stiffnessFromOrigami(tension), damping: dampingFromOrigami(quadOut(b, noBounce(tension), 0.01)), mass: 1 };
}

/** Animated.spring's tension and friction (its defaults with neither: 40 and 7). */
export const tensionSpring = (tension = 40, friction = 7) => ({ stiffness: stiffnessFromOrigami(tension), damping: dampingFromOrigami(friction), mass: 1 });
