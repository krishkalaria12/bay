// Static grain: one cell per `grainScale` CSS pixels from the view's top-left, a fixed seed, never animated.
// The shader multiplies the gradient by (1 - opacity * (1 - g)). A black layer whose alpha is (1 - g), drawn at
// `opacity`, darkens by exactly that much, so the same tile serves the CSS fallback and glass windows, where there
// is no gradient to multiply.

export const GRAIN_TILE = 128;

/** Dave Hoskins' hash12, the shader's grainHash. */
export function grainHash(x: number, y: number): number {
  const fract = (v: number) => v - Math.floor(v);
  let p0 = fract(x * 0.1031),
    p1 = fract(y * 0.1031),
    p2 = fract(x * 0.1031);
  const d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
  p0 += d;
  p1 += d;
  p2 += d;
  return fract((p0 + p1) * p2);
}

/** What the shader does with the grain inputs: opacity 0–1, at least 0.25 CSS pixels a cell, finite or the default. */
export function grainInputs(opacity: number | undefined, scale: number | undefined, defaults: { opacity: number; scale: number }) {
  const o = Number.isFinite(opacity) ? opacity! : defaults.opacity;
  const s = Number.isFinite(scale) ? scale! : defaults.scale;
  return { opacity: Math.min(1, Math.max(0, o)), scale: Math.max(0.25, s) };
}

let tile: string | null | undefined;
/** A GRAIN_TILE-cell square of black at alpha (1 - g), as a data URL; null without a DOM canvas. */
export function grainTile(): string | null {
  if (tile !== undefined) return tile;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = GRAIN_TILE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return (tile = null);
    const image = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let y = 0; y < GRAIN_TILE; y++)
      for (let x = 0; x < GRAIN_TILE; x++) image.data[(y * GRAIN_TILE + x) * 4 + 3] = Math.round((1 - grainHash(x, y)) * 255);
    ctx.putImageData(image, 0, 0);
    tile = canvas.toDataURL("image/png");
  } catch {
    tile = null;
  }
  return tile;
}
