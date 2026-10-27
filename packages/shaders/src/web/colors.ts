// Colour math shared by the WebGL uniforms and the CSS fallbacks. Same formulas as the Metal views.

export type RGBA = [number, number, number, number];

/** "#RRGGBB" or "#RRGGBBAA" to 0–1 channels; null for anything else, as SIMD4(hex:) does. */
export function parseHex(hex: string): RGBA | null {
  const s = hex.trim().replace(/^#/, "");
  if ((s.length !== 6 && s.length !== 8) || !/^[0-9a-f]+$/i.test(s)) return null;
  const v = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return [v(0), v(2), v(4), s.length === 8 ? v(6) : 1];
}

const cache = new Map<string, RGBA | null>();
/** parseHex, remembered: themes repeat the same few colours. */
export function color(hex: string): RGBA | null {
  let c = cache.get(hex);
  if (c === undefined) {
    if (cache.size > 256) cache.clear();
    cache.set(hex, (c = parseHex(hex)));
  }
  return c;
}

/** Gamma sRGB + alpha to OKLab + alpha (WindowBackdropView.oklab). */
export function oklab([r0, g0, b0, a]: RGBA): RGBA {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const r = lin(r0),
    g = lin(g0),
    b = lin(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    a,
  ];
}

/** HSL lightness shifted by `delta` (WindowTreatmentView.adjustingLightness). */
export function adjustLightness([r, g, b, a]: RGBA, delta: number): RGBA {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  const l2 = Math.min(Math.max(l + delta, 0), 1);
  if (s === 0) return [l2, l2, l2, a];
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
  const p = 2 * l2 - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3), a];
}

export function css([r, g, b, a]: RGBA, alpha = 1): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${c(r)},${c(g)},${c(b)},${+Math.min(1, Math.max(0, a * alpha)).toFixed(4)})`;
}

/** Up to `max` palette stops: a named palette, or the parsed hex list. */
export function palette(value: string | string[] | undefined, named: Record<string, string[]>, fallback: string, max = 16): RGBA[] {
  const list = typeof value === "string" ? [value] : (value ?? [fallback]);
  const hexes = list.length === 1 && named[list[0]!] ? named[list[0]!]! : list;
  const parsed = hexes.map(color).filter((c): c is RGBA => c !== null);
  return (parsed.length ? parsed : named[fallback]!.map((h) => parseHex(h)!)).slice(0, max);
}
