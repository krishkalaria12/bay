import type { JSX } from "react";
import { Pressable } from "react-native";

import type { PillButtonProps } from "./PillButton.types";
import { Text } from "./Text";

// A short text action ("Open", "Cancel"): a flat translucent capsule.
export function PillButton({ testID, label, accessibilityLabel, onPress, disabled = false, compact }: PillButtonProps): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 items-center justify-center rounded-full bg-default ${compact ? "px-3" : "px-4"}`}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text variant="subhead">{label}</Text>
    </Pressable>
  );
}
