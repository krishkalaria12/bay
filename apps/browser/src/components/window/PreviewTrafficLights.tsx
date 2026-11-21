import { capabilities, View } from "@bay/platform";
import type { ComponentProps } from "react";

const COLORS = ["#FF5F57", "#FEBC2E", "#28C840"];

/** The window buttons in a miniature window, where the real ones are traffic lights. */
export function PreviewTrafficLights({ size, style }: { size: number; style?: ComponentProps<typeof View>["style"] }) {
  if (!capabilities.trafficLights) return null;

  return (
    <View style={style}>
      {COLORS.map((color) => (
        <View key={color} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
      ))}
    </View>
  );
}
