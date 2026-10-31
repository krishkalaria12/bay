import { Button, Host, Image } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, controlSize, frame } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { View } from "react-native";

import { barButtons, type BrowserBarProps } from "./BrowserBar.types";
import { GlassIconButton } from "./GlassIconButton";
import { useStableCallback } from "./useStableCallback";

const symbols = { archive: "archivebox", tabs: "square.on.square", settings: "gearshape", more: "ellipsis" } as const;

// iOS: Liquid Glass buttons, a wide search capsule between two round ones.
export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const [left, search, right] = barButtons(props);
  const onSearch = useStableCallback(search.onPress);
  return (
    <View className="flex-row items-center justify-center gap-4">
      <GlassIconButton id={left.id} label={left.label} systemImage={symbols[left.icon]} onPress={left.onPress} />
      <View testID={search.id} collapsable={false}>
        <Host matchContents>
          <Button onPress={onSearch} modifiers={[buttonStyle("glass"), controlSize("large"), accessibilityLabel(search.label)]}>
            <Image systemName="magnifyingglass" modifiers={[frame({ width: 92 })]} />
          </Button>
        </Host>
      </View>
      <GlassIconButton id={right.id} label={right.label} systemImage={symbols[right.icon]} onPress={right.onPress} />
    </View>
  );
}
