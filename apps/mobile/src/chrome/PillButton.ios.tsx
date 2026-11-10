import { Button, Host } from "@expo/ui/swift-ui";
import { accessibilityIdentifier, accessibilityLabel, buttonStyle, controlSize, disabled } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { View } from "react-native";

import type { PillButtonProps } from "./PillButton.types";
import { useStableCallback } from "./useStableCallback";

// A short text action ("Open", "Cancel") as a Liquid Glass capsule.
export function PillButton({ testID, label, accessibilityLabel: a11yLabel, onPress, disabled: isDisabled = false }: PillButtonProps): JSX.Element {
  // Download rows re-render with every progress update; a changing handler can drop a tap.
  const press = useStableCallback(onPress);

  return (
    <View testID={testID} collapsable={false}>
      <Host matchContents>
        <Button
          label={label}
          onPress={press}
          modifiers={[
            buttonStyle("glass"),
            controlSize("regular"),
            accessibilityLabel(a11yLabel),
            // The identifier belongs on the button itself: the view around it is only a frame.
            accessibilityIdentifier(testID),
            disabled(isDisabled),
          ]}
        />
      </Host>
    </View>
  );
}
