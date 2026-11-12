import { Button, HStack, Host, Image, Text } from "@expo/ui/swift-ui";
import { accessibilityIdentifier, accessibilityLabel, buttonStyle, controlSize, font, frame, tint, truncationMode } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";

import { useT } from "@/i18n";

import { barButtons, barInsecure, barLoading, barNewTab, barProgress, barSite, type BrowserBarProps } from "./BrowserBar.types";
import { GlassIconButton } from "./GlassIconButton";
import { LoadProgress } from "./LoadProgress";
import { SwipeUp } from "./SwipeUp";
import { TabCount } from "./TabCount";
import { useStableCallback } from "./useStableCallback";

const symbols = { archive: "archivebox", tabs: "square.on.square", settings: "gearshape", more: "ellipsis" } as const;
const PRIVATE_TINT = "#18181B";

// iOS: Liquid Glass buttons, a wide search capsule between two round ones.
export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const t = useT();
  const [left, search, right] = barButtons(props, t);
  const site = barSite(props);
  const insecure = barInsecure(props);
  const onSearch = useStableCallback(search.onPress);
  const prominentTint = props.privately ? PRIVATE_TINT : undefined;

  return (
    <View className="flex-row items-center justify-center gap-4">
      <SwipeUp onSwipeUp={props.mode === "page" ? props.onTabsSwipeUp : undefined}>
        <GlassIconButton
          id={left.id}
          label={left.label}
          systemImage={symbols[left.icon]}
          prominentTint={prominentTint}
          onPress={left.onPress}
          onLongPress={left.onLongPress}
        >
          {left.badge ? <TabCount count={left.badge} /> : null}
        </GlassIconButton>
      </SwipeUp>
      <Animated.View testID={search.id} collapsable={false} style={props.capsuleStyle}>
        <Host matchContents>
          <Button
            onPress={onSearch}
            modifiers={[
              ...(prominentTint ? [buttonStyle("glassProminent"), tint(prominentTint)] : [buttonStyle("glass")]),
              controlSize("large"),
              accessibilityLabel(search.label),
              accessibilityIdentifier(search.id),
            ]}
          >
            {barNewTab(props) ? (
              <HStack spacing={6} modifiers={[frame({ width: 136, height: 20 })]}>
                <Image systemName="plus" size={15} />
                <Text modifiers={[font({ size: 15, weight: "medium" })]}>{t("bar.newTab")}</Text>
              </HStack>
            ) : site ? (
              // A fixed height keeps the host on one line, truncated.
              <HStack spacing={4} modifiers={[frame({ width: 136, height: 20 })]}>
                {insecure ? <Image systemName="exclamationmark.triangle.fill" color="red" size={13} /> : null}
                <Text modifiers={[font({ size: 15, weight: "medium" }), truncationMode("tail")]}>{site}</Text>
              </HStack>
            ) : (
              <Image systemName="magnifyingglass" modifiers={[font({ size: 17, weight: "medium" }), frame({ width: 92, height: 20 })]} />
            )}
          </Button>
        </Host>
        {/* The load's progress runs along the capsule's edge (A6). */}
        <LoadProgress progress={barProgress(props)} loading={barLoading(props)} />
      </Animated.View>
      <GlassIconButton
        id={right.id}
        label={right.label}
        systemImage={symbols[right.icon]}
        prominentTint={prominentTint}
        onPress={right.onPress}
        onLongPress={right.onLongPress}
      />
    </View>
  );
}
