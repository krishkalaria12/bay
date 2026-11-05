import { Typography } from "heroui-native";
import type { JSX } from "react";
import { Pressable } from "react-native";

import type { PillButtonProps } from "./PillButton.types";

// A short text action ("Open", "Cancel"): a flat translucent capsule.
export function PillButton({ testID, label, accessibilityLabel, onPress, compact }: PillButtonProps): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`min-h-11 items-center justify-center rounded-full bg-default ${compact ? "px-3" : "px-4"}`}
    >
      <Typography className="text-sm">{label}</Typography>
    </Pressable>
  );
}
