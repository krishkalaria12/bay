import { Host, Toggle as SwiftToggle } from "@expo/ui/swift-ui";
import { accessibilityHidden, disabled as disable, labelsHidden, tint } from "@expo/ui/swift-ui/modifiers";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";

import type { ToggleProps } from "./Toggle.types";

// SwiftUI's own switch, which sizes itself the way the system draws it: React Native's UISwitch kept the old switch's
// frame and drew the new, shorter one at its top, above the middle of the row. The row around it handles the tap and
// reports the switch's role and state (ActionRow), so the switch ignores touches and stays out of VoiceOver: read twice,
// the row would say "switch" twice. Tinted with Bay's accent, like the Android switch, rather than the system green.
export function Toggle({ value, disabled }: ToggleProps): JSX.Element {
  const accent = useThemeColor("accent");

  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Host matchContents>
        <SwiftToggle isOn={value} modifiers={[labelsHidden(), tint(accent), disable(disabled ?? false), accessibilityHidden(true)]} />
      </Host>
    </View>
  );
}
