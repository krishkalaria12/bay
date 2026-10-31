import type { JSX } from "react";
import { StyleSheet, useColorScheme } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Pattern, Rect, Stop } from "react-native-svg";

// Bay's start page: sea mist fading into sand, under a fine dot grid.
const palettes = {
  light: { top: "#B8D3EA", middle: "#D9E4EF", bottom: "#EEDFD9", dot: "#1B2A3A", dotOpacity: 0.07 },
  dark: { top: "#0F1C2A", middle: "#14202C", bottom: "#231D24", dot: "#FFFFFF", dotOpacity: 0.06 },
};

export function Wallpaper(): JSX.Element {
  const colors = palettes[useColorScheme() === "dark" ? "dark" : "light"];
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="wash" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.top} />
          <Stop offset="0.55" stopColor={colors.middle} />
          <Stop offset="1" stopColor={colors.bottom} />
        </LinearGradient>
        <Pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
          <Circle cx="7" cy="7" r="0.9" fill={colors.dot} fillOpacity={colors.dotOpacity} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#wash)" />
      <Rect width="100%" height="100%" fill="url(#dots)" />
    </Svg>
  );
}
