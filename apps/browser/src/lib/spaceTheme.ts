import type { SpaceTheme } from "../store/types";
import { hexFromHsl, hslOf } from "./windowTint";

// The theme editor's colour field (assets/theme-spectrum.png, drawn with the same mapping): hue left to right,
// light pastel at the top to deep at the bottom, at one saturation.
const SATURATION = 0.72;
const TOP_LIGHTNESS = 0.82;
const BOTTOM_LIGHTNESS = 0.34;

/** The colour at a point of the field, x and y 0–1. */
export function spectrumColor(x: number, y: number): string {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return hexFromHsl(clamp(x), SATURATION, TOP_LIGHTNESS + (BOTTOM_LIGHTNESS - TOP_LIGHTNESS) * clamp(y));
}

/** Where a colour sits on the field (the nearest point: its saturation isn't the field's). */
export function spectrumPosition(color: string): { x: number; y: number } {
  const [h, , l] = hslOf(color);
  return { x: h, y: Math.min(1, Math.max(0, (l - TOP_LIGHTNESS) / (BOTTOM_LIGHTNESS - TOP_LIGHTNESS))) };
}

export const MAX_THEME_COLORS = 3;
export const DEFAULT_INTENSITY = 0.5;
export const DEFAULT_GRAIN = 0.3;

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
