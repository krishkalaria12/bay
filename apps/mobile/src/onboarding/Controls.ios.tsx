import { GlassNameView } from "@bay/mobile-welcome";
import { Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { accessibilityHidden, foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";

import { GlassIconButton } from "@/chrome/GlassIconButton.ios";
import { PillButton } from "@/chrome/PillButton.ios";

import type { BackButtonProps, BackdropProps, NameProps, SkipButtonProps } from "./Controls.types";

// The welcome in Liquid Glass. The glass is only a backdrop, so VoiceOver skips it; what's on it says what it is.

const tints = {
  clear: "#FFFFFF33",
  solid: "#FFFFFFF0",
  night: "#1A1A1EE6",
} as const;

export function Backdrop({ radius, tone }: BackdropProps): JSX.Element {
  return (
    <Host style={StyleSheet.absoluteFill} pointerEvents="none">
      <RoundedRectangle
        cornerRadius={radius}
        modifiers={[
          foregroundStyle("transparent"),
          glassEffect({ glass: { variant: "regular", tint: tints[tone] }, ["shape"]: "roundedRectangle", cornerRadius: radius }),
          accessibilityHidden(true),
        ]}
      />
    </Host>
  );
}

export function BackButton({ testID, label, visible, onPress }: BackButtonProps): JSX.Element {
  return (
    <View style={{ opacity: visible ? 1 : 0 }} pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible}>
      <GlassIconButton id={testID} label={label} systemImage="chevron.left" onPress={onPress} />
    </View>
  );
}

export function SkipButton({ testID, label, visible, onPress }: SkipButtonProps): JSX.Element {
  return (
    <View style={{ opacity: visible ? 1 : 0 }} pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible}>
      <PillButton testID={testID} label={label} accessibilityLabel={label} onPress={onPress} />
    </View>
  );
}

export function Name({ text, width, height }: NameProps): JSX.Element {
  return <GlassNameView text={text} style={{ width, height }} />;
}
