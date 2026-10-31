import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled, labelStyle } from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps, JSX } from "react";
import { View } from "react-native";

import { useStableCallback } from "./useStableCallback";

export function GlassIconButton(props: {
  id: string;
  label: string;
  systemImage: ComponentProps<typeof Button>["systemImage"];
  isDisabled?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const onPress = useStableCallback(props.onPress);
  return (
    <View testID={props.id} collapsable={false}>
      <Host matchContents>
        <Button
          label={props.label}
          systemImage={props.systemImage}
          modifiers={[buttonStyle("glass"), labelStyle("iconOnly"), controlSize("large"), disabled(props.isDisabled ?? false)]}
          onPress={onPress}
        />
      </Host>
    </View>
  );
}
