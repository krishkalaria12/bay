import { GlassEffect, Surface, VisualEffect } from "@bay/shell";
import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../../lib/theme";
import { liquidGlass } from "../glass";

export function PaletteSurface({ children, style, radius = 22, raised = false }: {
  children: ReactNode;
  style?: ViewStyle;
  radius?: number;
  raised?: boolean;
}) {
  const theme = useTheme();
  return (
    <Surface
      fill="#00000000"
      cornerRadius={radius}
      shadowColor="#000000"
      shadowOpacity={theme.dark ? 0.36 : 0.18}
      shadowRadius={raised ? 22 : 36}
      shadowOffset={[0, raised ? 8 : 16]}
      style={style}
    >
      {liquidGlass ? (
        <GlassEffect pointerEvents="none" dark={theme.dark} tint={theme.dark ? (raised ? "#353238A0" : "#24212B85") : "#F5F4F5B0"} cornerRadius={radius} style={StyleSheet.absoluteFill} />
      ) : (
        <>
          <VisualEffect material="popover" blendingMode="withinWindow" cornerRadius={radius} style={StyleSheet.absoluteFill} />
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: theme.dark ? "rgba(35,33,39,0.82)" : "rgba(250,249,252,0.85)" }]} />
        </>
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 0.5, borderColor: theme.dark ? "#FFFFFF24" : "#00000020" }]} />
      {children}
    </Surface>
  );
}
