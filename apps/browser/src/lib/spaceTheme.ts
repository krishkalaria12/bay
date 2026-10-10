import type { SpaceTheme } from "../store/types";
import { BOTTOM_LIGHTNESS, DEFAULT_GRAIN, DEFAULT_INTENSITY, SATURATION, TOP_LIGHTNESS } from "./constants";
import { hexFromHsl, hslOf } from "./windowTint";

// The theme editor's field is a colour wheel, as Zen's is: round its centre the hue, and out from it the lightness,
// dark in the middle to light at the edge (kept to the range that tints a window well).

/** The colour at a point of the wheel: `angle` 0–1 clockwise from the right, `distance` 0–1 from the centre. */
export function wheelColor(angle: number, distance: number): string {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return hexFromHsl(((angle % 1) + 1) % 1, SATURATION, BOTTOM_LIGHTNESS + (TOP_LIGHTNESS - BOTTOM_LIGHTNESS) * clamp(distance));
}

/** Where a colour sits on the wheel (the nearest point: its saturation isn't the wheel's). */
export function wheelPosition(color: string): { angle: number; distance: number } {
  const [h, , l] = hslOf(color);
  return { angle: h, distance: Math.min(1, Math.max(0, (l - BOTTOM_LIGHTNESS) / (TOP_LIGHTNESS - BOTTOM_LIGHTNESS))) };
}

// Colour harmonies: the other colours' hues, in degrees from the first's. A theme of n colours takes one with n − 1.
export type Harmony = "complementary" | "singleAnalogous" | "splitComplementary" | "analogous" | "triadic" | "floating";
const HARMONIES: { type: Harmony; angles: number[] }[] = [
  { type: "complementary", angles: [180] },
  { type: "singleAnalogous", angles: [310] },
  { type: "splitComplementary", angles: [150, 210] },
  { type: "analogous", angles: [50, 310] },
  { type: "triadic", angles: [120, 240] },
  { type: "floating", angles: [] },
];
const anglesOf = (type: Harmony) => HARMONIES.find((h) => h.type === type)!.angles;
const fits = (count: number) => HARMONIES.filter((h) => h.angles.length === count - 1);

/** The harmony a theme of `count` colours starts with: complementary for two, split complementary for three. */
export const defaultHarmony = (count: number): Harmony => fits(count)[0]?.type ?? "floating";

/** The next harmony for the same number of colours, round and back to the first. */
export function nextHarmony(type: Harmony, count: number): Harmony {
  const list = fits(count);
  const i = list.findIndex((h) => h.type === type);
  return list[(i + 1) % list.length]?.type ?? "floating";
}

/** The harmony after a colour goes: three analogous colours leave two analogous ones. */
export const harmonyAfterRemoving = (type: Harmony, count: number): Harmony => (type === "analogous" && count === 2 ? "singleAnalogous" : defaultHarmony(count));

/** The first colour, then the others its harmony places round the wheel from it, as light as it is. */
export function harmonize(first: string, type: Harmony): string[] {
  const [h, s, l] = hslOf(first);
  return [first, ...anglesOf(type).map((deg) => hexFromHsl((h + deg / 360) % 1, s, l))];
}

// Arc-style gradient themes, beside the preset colours.
export const THEME_PRESETS: { name: string; colors: string[] }[] = [
  { name: "Sunset", colors: ["#FF7E5F", "#FEB47B"] },
  { name: "Twilight", colors: ["#7F5AF0", "#E84393"] },
  { name: "Aurora", colors: ["#16F2B3", "#0DB4F7"] },
  { name: "Dusk", colors: ["#3A6073", "#F3904F"] },
];

/** The editor's starting point for a space: its own theme, or one from its preset colour. */
export function editableTheme(theme: SpaceTheme | null | undefined, swatch: string): SpaceTheme {
  return theme?.colors.length ? theme : { colors: [swatch.slice(0, 7).toUpperCase()], intensity: DEFAULT_INTENSITY, grain: DEFAULT_GRAIN };
}
