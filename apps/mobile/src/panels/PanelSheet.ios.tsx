import { Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { accessibilityHidden, foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import type { BottomSheetBackgroundProps } from "@gorhom/bottom-sheet";
import type { JSX } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";

import { radius } from "@/chrome/tokens";

import { PanelSheetShared, type PanelSheetProps } from "./PanelSheetShared";

export type { PanelSheetProps } from "./PanelSheetShared";

export { ActionRow, Group, SectionLabel, SheetFitEnd, SheetIconButton } from "./PanelSheetShared";

// iOS: the same sheet contents as Android, over a Liquid Glass background (I6) instead of a solid one.
export function PanelSheet(props: PanelSheetProps): JSX.Element {
  return (
    <PanelSheetShared {...props} background={GlassBackground}>
      {props.children}
    </PanelSheetShared>
  );
}

// The glass is tinted toward the app's background (bg-background, with alpha) so muted text stays readable over a
// bright or busy page; the page still shows through.
const TINT = { light: "#F5F5F580", dark: "#121214A6" } as const;

// The sheet's background layer: glass under the handle and the rows. It runs a corner's height past the sheet's bottom edge, so
// the rounded corners only show at the top; the extra reaches under the home indicator, off screen. The shape key is
// Expo's native field name.
function GlassBackground({ style }: BottomSheetBackgroundProps): JSX.Element {
  const tint = TINT[useColorScheme() === "dark" ? "dark" : "light"];

  return (
    <View style={style} pointerEvents="none">
      <Host style={[StyleSheet.absoluteFill, { bottom: -radius.sheet }]}>
        <RoundedRectangle
          cornerRadius={radius.sheet}
          modifiers={[
            foregroundStyle("transparent"),
            glassEffect({ glass: { variant: "regular", tint }, ["shape"]: "roundedRectangle", cornerRadius: radius.sheet }),
            // Only a backdrop: VoiceOver skips it.
            accessibilityHidden(true),
          ]}
        />
      </Host>
    </View>
  );
}
