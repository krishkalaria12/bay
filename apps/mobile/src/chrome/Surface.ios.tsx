import { Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { accessibilityHidden, foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";

import type { SurfaceProps } from "./Surface.types";

// A Liquid Glass panel behind React Native content. The glass is only a backdrop, so VoiceOver skips it.
// The shape key is Expo's native field name, so it is written as a string key.
export function Surface({ radius, children, style, testID }: SurfaceProps): JSX.Element {
  return (
    <View testID={testID} style={[{ borderRadius: radius }, style]}>
      <Host style={StyleSheet.absoluteFill} pointerEvents="none">
        <RoundedRectangle
          cornerRadius={radius}
          modifiers={[
            foregroundStyle("transparent"),
            glassEffect({ glass: { variant: "regular" }, ["shape"]: "roundedRectangle", cornerRadius: radius }),
            accessibilityHidden(true),
          ]}
        />
      </Host>
      {children}
    </View>
  );
}
