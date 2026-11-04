// The CSS every effect shows first, and keeps when WebGL2 is off, blocked, failed or lost.

import type { Rect } from "../types";
import { color, css } from "./colors";
import { GRAIN_TILE, grainTile } from "./grain";
import { fill } from "./ShaderView";

let oklabGradients: boolean | undefined;
/** The two-stop gradient, mixed in OKLab where CSS can, as the shader mixes it. */
export function gradientCss(angle: number, from: string, to: string): string {
  oklabGradients ??= typeof CSS !== "undefined" && CSS.supports("background-image", "linear-gradient(in oklab, red, blue)");
  return `linear-gradient(${oklabGradients ? "in oklab " : ""}${angle}deg, ${from}, ${to})`;
}

/** Static grain over whatever is below, the shader's multiply as a black layer (see grain.ts). */
export function GrainLayer({ opacity, scale }: { opacity: number; scale: number }) {
  const tile = opacity > 0 ? grainTile() : null;
  if (!tile) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        ...fill,
        opacity,
        backgroundImage: `url(${tile})`,
        backgroundSize: `${GRAIN_TILE * scale}px ${GRAIN_TILE * scale}px`,
        backgroundPosition: "0 0",
        imageRendering: "pixelated",
      }}
    />
  );
}

/** AreaLight without a GPU: a still glow under the emitter. */
export function AreaGlow({ source, colorHex, cornerRadius }: { source: Rect; colorHex: string; cornerRadius: number }) {
  const c = color(colorHex) ?? [1, 1, 1, 1];
  const spread = Math.max(source.width, source.height) * 0.35;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        pointerEvents: "none",
        left: source.x,
        top: source.y,
        width: source.width,
        height: source.height,
        borderRadius: cornerRadius,
        boxShadow: `0 ${spread * 0.25}px ${spread}px ${spread * 0.2}px ${css(c, 0.45)}`,
      }}
    />
  );
}

/** EdgeLight without a GPU: the lit outline, still. */
export function EdgeOutline({ rect, colorHex, cornerRadius }: { rect: Rect; colorHex: string | undefined; cornerRadius: number }) {
  const c = (colorHex && color(colorHex)) || [1, 1, 1, 0.5];
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        pointerEvents: "none",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        boxSizing: "border-box",
        border: `1px solid ${css(c)}`,
        borderRadius: cornerRadius,
      }}
    />
  );
}
