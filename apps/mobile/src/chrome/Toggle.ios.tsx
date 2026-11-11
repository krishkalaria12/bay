import type { JSX } from "react";
import { Switch } from "react-native";

import type { ToggleProps } from "./Toggle.types";

// UISwitch. The row around it handles the tap and reports the switch's role and state (ActionRow), so the switch
// itself ignores touches and stays out of VoiceOver: read twice, the row would say "switch" twice.
export function Toggle({ value, disabled }: ToggleProps): JSX.Element {
  return <Switch value={value} disabled={disabled} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
