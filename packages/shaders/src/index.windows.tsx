import { View } from "@bay/platform";

import type { AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export type { Rect, AreaLightPalette, AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export const DIA_SPECTRUM = ["#0358F7", "#5092C7", "#E1E1FE", "#FFD400", "#FA3D1D", "#FD02F5"];

// Metal decoration is outside the Windows port. Preserve layout without importing its native views.
export function AreaLight(_props: AreaLightProps) { return null; }
export function EdgeLight(_props: EdgeLightProps) { return null; }
export function PowerUp(_props: PowerUpProps) { return null; }
export function WindowBackdrop({ colors, style, children }: WindowBackdropProps) {
  return <View pointerEvents="none" style={[{ backgroundColor: colors[0] }, style]}>{children}</View>;
}
