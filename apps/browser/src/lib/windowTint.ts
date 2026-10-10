import { INACTIVE_FILL, SOLID_FILL, TINT_LIGHTNESS } from "./constants";

// AppKit makes the visual-effect fill opaque when inactive or Reduce Transparency is on.
export type BackdropTint = {
  tintColor: string;
  tintAlpha: number;
  tintLightness: number;
};

export function backdropTint(color: string, neutral: boolean): BackdropTint {
  // Dia: 0.12 / 0.36.
  return { tintColor: color, tintAlpha: neutral ? 0.12 : 0.36, tintLightness: TINT_LIGHTNESS };
}

// What the tint is laid over.
function baseFill(dark: boolean, solid: boolean): number[] {
  if (solid) return SOLID_FILL[dark ? "dark" : "light"];
  if (dark) return INACTIVE_FILL.dark.map((f) => 0.6 * f);
  return INACTIVE_FILL.light.map((f) => 0.8 * 255 + 0.2 * f);
}

/** The window's colours with nothing showing through: glass's when the window is inactive, or a solid window's. */
export function opaqueTint(tint: BackdropTint, dark: boolean, solid = false): [string, string] {
  const a = tint.tintAlpha * (dark ? 0.5 : 0.75);
  const under = baseFill(dark, solid);
  const top = rgb(tint.tintColor);
  const bottom = lighten(top, tint.tintLightness);
  const over = (c: number[]) => hex(c.map((v, i) => a * v + (1 - a) * under[i]!));
  return [over(top), over(bottom)];
}

// Dia: 349°, 0.36, 0.53.
export function tintForHue(swatch: string, grey = false): string {
  const [h] = hsl(rgb(swatch));
  return hex(fromHsl(h, grey ? 0 : 0.36, 0.527));
}

const rgb = (hex: string) => [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16));
const hex = (c: number[]) =>
  `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether dark text reads better than white on a "#RRGGBB" colour. */
export function isLightColor(color: string): boolean {
  const l = luminance(color);
  return 1.05 / (l + 0.05) < (l + 0.05) / 0.05;
}

/** A "#RRGGBB" colour's hue, saturation and lightness, each 0–1. */
export const hslOf = (color: string) => hsl(rgb(color));
/** A "#RRGGBB" colour from hue, saturation and lightness, each 0–1. */
export const hexFromHsl = (h: number, s: number, l: number) => hex(fromHsl(h, s, l));

function hsl([r, g, b]: number[]): [number, number, number] {
  const [R, G, B] = [r! / 255, g! / 255, b! / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): number[] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number) => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((v) => v * 255);
}

function lighten(c: number[], delta: number): number[] {
  const [h, s, l] = hsl(c);
  return fromHsl(h, s, Math.min(1, Math.max(0, l + delta)));
}
