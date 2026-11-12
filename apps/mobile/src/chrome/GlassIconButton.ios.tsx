import { Button, Host, Image } from "@expo/ui/swift-ui";
import * as modifiers from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps, JSX, ReactNode } from "react";
import { View } from "react-native";

import { useStableCallback } from "./useStableCallback";

/**
 * The symbol's box inside the glass: the same height as the search capsule's text line, so the round buttons and the
 * capsule beside them stand equally tall. Every symbol gets the same box, so a short one (the ellipsis) makes as big a
 * button as a tall one (the tabs).
 */
const SYMBOL_BOX = 20;

export function GlassIconButton(props: {
  id: string;
  label: string;
  systemImage: NonNullable<ComponentProps<typeof Image>["systemName"]>;
  isDisabled?: boolean;
  /** Prominent glass in this colour instead of clear glass. */
  prominentTint?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Drawn over the button, e.g. a count. */
  children?: ReactNode;
}): JSX.Element {
  const onPress = useStableCallback(props.onPress);
  const onLongPress = useStableCallback(props.onLongPress);

  return (
    <View testID={props.id} collapsable={false}>
      <Host matchContents>
        <Button
          modifiers={[
            ...(props.prominentTint ? [modifiers.buttonStyle("glassProminent"), modifiers.tint(props.prominentTint)] : [modifiers.buttonStyle("glass")]),
            modifiers.buttonBorderShape("circle"),
            modifiers.controlSize("large"),
            modifiers.accessibilityLabel(props.label),
            // On the button itself, so the accessibility tree names it as tests do; the view around it is only a frame.
            modifiers.accessibilityIdentifier(props.id),
            modifiers.disabled(props.isDisabled ?? false),
            ...(props.onLongPress ? [modifiers.onLongPressGesture(onLongPress)] : []),
          ]}
          onPress={onPress}
        >
          <Image
            systemName={props.systemImage}
            modifiers={[modifiers.font({ size: 17, weight: "medium" }), modifiers.frame({ width: SYMBOL_BOX, height: SYMBOL_BOX })]}
          />
        </Button>
      </Host>
      {props.children}
    </View>
  );
}
