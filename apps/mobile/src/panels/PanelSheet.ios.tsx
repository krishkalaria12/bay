import { Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { StyleSheet } from "react-native";

import { PanelSheetShared, type PanelSheetProps } from "./PanelSheetShared";

export type { PanelSheetProps } from "./PanelSheetShared";
export { ActionRow, Group, SectionLabel } from "./PanelSheetShared";

// iOS: the same sheet contents as Android, over a Liquid Glass background (I6) instead of a solid one.
export function PanelSheet(props: PanelSheetProps): JSX.Element {
  return (
    <PanelSheetShared {...props} backdrop={<GlassBackdrop />}>
      {props.children}
    </PanelSheetShared>
  );
}

// The glass fills the sheet and runs 28pt past its bottom edge, so the rounded corners only show at the top; the
// extra reaches under the home indicator, off screen. The shape key is Expo's native field name.
function GlassBackdrop(): JSX.Element {
  return (
    <Host pointerEvents="none" style={[StyleSheet.absoluteFill, { bottom: -28 }]}>
      <RoundedRectangle
        cornerRadius={28}
        modifiers={[foregroundStyle("transparent"), glassEffect({ glass: { variant: "regular" }, ["shape"]: "roundedRectangle", cornerRadius: 28 })]}
      />
    </Host>
  );
}
