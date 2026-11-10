import type { JSX } from "react";
import { Switch } from "react-native";

import type { ToggleProps } from "./Toggle.types";

// UISwitch. The row around it handles the tap, so the switch itself ignores touches.
export function Toggle({ value, disabled }: ToggleProps): JSX.Element {
  return <Switch value={value} disabled={disabled} pointerEvents="none" />;
}
