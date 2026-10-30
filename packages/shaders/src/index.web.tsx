import { capabilities, View } from "@bay/platform";
import type { AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export type { Rect, AreaLightPalette, AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export const DIA_SPECTRUM = ["#0358F7", "#5092C7", "#E1E1FE", "#FFD400", "#FA3D1D", "#FD02F5"];

// Metal-specific decoration is excluded from the desktop web host.
export function AreaLight(_props: AreaLightProps) {
  return null;
}
export function EdgeLight(_props: EdgeLightProps) {
  return null;
}
export function PowerUp(_props: PowerUpProps) {
  return null;
}
export function WindowBackdrop({
  colors,
  vibrancy = false,
  angle = 180,
  tintColor,
  tintAlpha = 0,
  grainOpacity = 0.1,
  grainScale = 1,
  style,
  children,
}: WindowBackdropProps) {
  // A glass window over the system backdrop (Mica) keeps only its tint, as macOS keeps it over vibrancy.
  if (vibrancy && capabilities.windowBackdrop) {
    return (
      <View pointerEvents="none" style={[{ overflow: "hidden" }, style]}>
        {tintColor && tintAlpha > 0 ? (
          <div
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundColor: tintColor, opacity: Math.max(0, Math.min(1, tintAlpha)) }}
          />
        ) : null}
        {children}
      </View>
    );
  }
  // As macOS's Metal backdrop: the colours blended in OKLab along the angle, under a multiplied grey grain. A solid
  // window's colours already hold its tint, which only glass draws again.
  const grain = Math.max(0, Math.min(1, grainOpacity));
  const tile = grain > 0 ? grainTile() : null;
  return (
    <View pointerEvents="none" style={[{ backgroundColor: colors[0], overflow: "hidden" }, style]}>
      <div
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", background: `linear-gradient(${angle}deg in oklab, ${colors[0]}, ${colors[1]})` }}
      />
      {tile ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            backgroundImage: `url(${tile})`,
            backgroundSize: `${GRAIN_TILE * Math.max(grainScale, 0.25)}px`,
            imageRendering: "pixelated",
            mixBlendMode: "multiply",
            opacity: grain,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

// One grey per cell, as the Metal shader's hash: multiplied at the grain's opacity, a cell scales its colour by
// 1 - opacity * (1 - grey).
const GRAIN_TILE = 128;
let grainUrl: string | null | undefined;
function grainTile() {
  if (grainUrl !== undefined) return grainUrl;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GRAIN_TILE;
  const context = canvas.getContext("2d");
  if (!context) return (grainUrl = null);
  const pixels = context.createImageData(GRAIN_TILE, GRAIN_TILE);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const grey = Math.floor(Math.random() * 256);
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = grey;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return (grainUrl = canvas.toDataURL("image/png"));
}
