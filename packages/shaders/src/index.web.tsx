import { capabilities, View } from "@bay/platform";
import type { AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export type { Rect, AreaLightPalette, AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
export const DIA_SPECTRUM = ["#0358F7", "#5092C7", "#E1E1FE", "#FFD400", "#FA3D1D", "#FD02F5"];

// Metal-specific decoration is excluded from the desktop web host.
export function AreaLight(_props: AreaLightProps) { return null; }
export function EdgeLight(_props: EdgeLightProps) { return null; }
export function PowerUp(_props: PowerUpProps) { return null; }
export function WindowBackdrop({ colors, vibrancy = false, angle = 180, tintColor, tintAlpha = 0, style, children }: WindowBackdropProps) {
  // A glass window over the system backdrop (Mica) keeps only its tint, as macOS keeps it over vibrancy.
  if (vibrancy && capabilities.windowBackdrop) {
    return <View pointerEvents="none" style={[{ overflow: "hidden" }, style]}>
      {tintColor && tintAlpha > 0 ? <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundColor: tintColor, opacity: Math.max(0, Math.min(1, tintAlpha)) }} /> : null}
      {children}
    </View>;
  }
  return <View pointerEvents="none" style={[{ backgroundColor: colors[0], overflow: "hidden" }, style]}>
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", background: `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]})` }} />
    {tintColor && tintAlpha > 0 ? <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundColor: tintColor, opacity: Math.max(0, Math.min(1, tintAlpha)) }} /> : null}
    {children}
  </View>;
}
