import type { ViewProps } from "@bay/platform";
import { requireNativeViewManager } from "@bay/platform/native";
import { GRAIN_OPACITY, GRAIN_SCALE } from "./constants";
import type { AreaLightProps, EdgeLightProps, PowerUpProps, Rect, WindowBackdropProps } from "./types";
export { DIA_SPECTRUM } from "./constants";
export type { Rect, AreaLightPalette, AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";

type NativeAreaLightProps = Omit<AreaLightProps, "source" | "palette"> & { shapeFrame: number[]; palette?: string[] };

const NativeAreaLight = requireNativeViewManager<NativeAreaLightProps>("BayAreaLight");

export function AreaLight({ source, palette = "pink", ...props }: AreaLightProps) {
  const shapeFrame = source ? [source.x, source.y, source.width, source.height] : [0, 0, 0, 0];
  return <NativeAreaLight pointerEvents="none" {...props} palette={typeof palette === "string" ? [palette] : palette} shapeFrame={shapeFrame} />;
}

const NativeBackdrop = requireNativeViewManager<WindowBackdropProps>("BayWindowBackdrop");

export function WindowBackdrop({ angle = 180, grainOpacity = GRAIN_OPACITY, grainScale = GRAIN_SCALE, ...props }: WindowBackdropProps) {
  return <NativeBackdrop pointerEvents="none" angle={angle} grainOpacity={grainOpacity} grainScale={grainScale} {...props} />;
}

type NativeEdgeLightProps = ViewProps & {
  rectFrame: number[];
  cornerRadius?: number;
  lightStart: number[];
  lightEnd: number[];
  lightColor?: string;
  logoFrame?: number[];
  animationDuration?: number;
  animationDelay?: number;
};

const NativeEdgeLight = requireNativeViewManager<NativeEdgeLightProps>("BayEdgeLight");
const rect = (r: Rect) => [r.x, r.y, r.width, r.height];

export function EdgeLight({ rectFrame, lightStart, lightEnd, logoFrame, ...props }: EdgeLightProps) {
  return (
    <NativeEdgeLight
      pointerEvents="none"
      {...props}
      rectFrame={rect(rectFrame)}
      lightStart={[lightStart.x, lightStart.y]}
      lightEnd={[lightEnd.x, lightEnd.y]}
      logoFrame={logoFrame ? rect(logoFrame) : [0, 0, 0, 0]}
    />
  );
}

type NativePowerUpProps = Omit<PowerUpProps, "palette" | "halo"> & { palette?: string[]; haloFrame: number[] };

const NativePowerUp = requireNativeViewManager<NativePowerUpProps>("BayPowerUp");

export function PowerUp({ palette = "pink", halo = null, ...props }: PowerUpProps) {
  return (
    <NativePowerUp pointerEvents="none" {...props} palette={typeof palette === "string" ? [palette] : palette} haloFrame={halo ? rect(halo) : [0, 0, 0, 0]} />
  );
}
