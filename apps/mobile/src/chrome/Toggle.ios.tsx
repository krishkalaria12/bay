import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Switch } from "react-native";

import type { ToggleProps } from "./Toggle.types";

// UISwitch. The row around it handles the tap and reports the switch's role and state (ActionRow), so the switch
// itself ignores touches and stays out of VoiceOver: read twice, the row would say "switch" twice.
// Tinted with Bay's accent, like the Android switch, rather than the system green.
export function Toggle({ value, disabled }: ToggleProps): JSX.Element {
  const accent = useThemeColor("accent");

  return (
    <Switch
      value={value}
      disabled={disabled}
      trackColor={{ true: accent }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
