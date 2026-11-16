import { Button, Host } from "@expo/ui/swift-ui";
import { accessibilityIdentifier, accessibilityLabel, buttonStyle, controlSize, disabled } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { View } from "react-native";

import type { PillButtonProps } from "./PillButton.types";
import { useStableCallback } from "./useStableCallback";

// A short text action ("Open", "Cancel") as a Liquid Glass capsule, at its natural size wherever it sits: the host
// takes the button's measured size, and the frame around it never grows or shrinks in a row. `compact` (rows next to
// other content) uses the small control size, iOS's version of Android's tighter capsule.
export function PillButton({ testID, label, accessibilityLabel: a11yLabel, onPress, disabled: isDisabled = false, compact }: PillButtonProps): JSX.Element {
  // Download rows re-render with every progress update; a changing handler can drop a tap.
  const press = useStableCallback(onPress);

  return (
    <View testID={testID} collapsable={false} style={{ flexGrow: 0, flexShrink: 0 }}>
      <Host matchContents>
        <Button
          label={label}
          onPress={press}
          modifiers={[
            buttonStyle("glass"),
            controlSize(compact ? "small" : "regular"),
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
