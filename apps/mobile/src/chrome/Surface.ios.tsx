import { Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";

import type { SurfaceProps } from "./Surface.types";

// A Liquid Glass panel behind React Native content.
export function Surface({ radius, children, style, testID }: SurfaceProps): JSX.Element {
  return (
    <View testID={testID} style={[{ borderRadius: radius }, style]}>
      <Host style={StyleSheet.absoluteFill} pointerEvents="none">
        <RoundedRectangle
          cornerRadius={radius}
          modifiers={[foregroundStyle("transparent"), glassEffect({ glass: { variant: "regular" }, shape: "roundedRectangle", cornerRadius: radius })]}
        />
      </Host>
      {children}
    </View>
  );
}
