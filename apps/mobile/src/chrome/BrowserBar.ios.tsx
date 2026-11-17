import { Button, HStack, Host, Image, Text } from "@expo/ui/swift-ui";
import {
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  controlSize,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  padding,
  shapes,
  tint,
  truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";

import { useT } from "@/i18n";

import { barButtons, barInsecure, barLoading, barNewTab, barProgress, barSite, type BarButton, type BarSpace, type BrowserBarProps } from "./BrowserBar.types";
import { GlassIconButton } from "./GlassIconButton";
import { LoadProgress } from "./LoadProgress";
import { SwipeUp } from "./SwipeUp";
import { TabCount } from "./TabCount";
import { useStableCallback } from "./useStableCallback";

const symbols = { archive: "archivebox", tabs: "square.on.square", settings: "gearshape", more: "ellipsis", add: "plus" } as const;
const PRIVATE_TINT = "#18181B";

// iOS: Liquid Glass buttons, a wide search capsule between two round ones.
export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const t = useT();
  const [left, search, right] = barButtons(props, t);
  const site = barSite(props);
  const insecure = barInsecure(props);
  const onSearch = useStableCallback(search.onPress);
  const prominentTint = props.privately ? PRIVATE_TINT : undefined;

  if (props.mode === "tabs") {
    return (
      <View className="flex-row items-center justify-center gap-3">
        <GlassIconButton id={left.id} label={left.label} systemImage={symbols[left.icon]} onPress={left.onPress} />
        <SpacesCapsule spaces={props.spaces} onSelect={props.onSelectSpace} newSpace={search} switchLabel={(name) => t("tabs.switchSpace", { name })} />
        <GlassIconButton id={right.id} label={right.label} systemImage={symbols[right.icon]} onPress={right.onPress} />
      </View>
    );
  }

  return (
    <View className="flex-row items-center justify-center gap-3">
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

/** The tab view's spaces between archive and new tab, in one glass capsule: a dot per space, the one showing larger. */
function SpacesCapsule({
  spaces,
  onSelect,
  newSpace,
  switchLabel,
}: {
  spaces: readonly BarSpace[];
  onSelect: (id: string) => void;
  newSpace: BarButton;
  switchLabel: (name: string) => string;
}): JSX.Element {
  const select = useStableCallback(onSelect);
  const onNewSpace = useStableCallback(newSpace.onPress);

  return (
    <View testID="bar-spaces" collapsable={false}>
      <Host matchContents>
        <HStack spacing={2} modifiers={[padding({ horizontal: 10, vertical: 6 }), glassEffect({ glass: { variant: "regular" }, ["shape"]: "capsule" })]}>
          {spaces.map((entry) => (
            <Button
              key={entry.id}
              onPress={() => select(entry.id)}
              modifiers={[
                buttonStyle("plain"),
                accessibilityLabel(switchLabel(entry.label)),
                accessibilityIdentifier(`bar-space-${entry.id}`),
                frame({ width: 34, height: 34 }),
              ]}
            >
              <Image systemName={entry.active ? "app.fill" : "circle.fill"} size={entry.active ? 18 : 9} modifiers={[foregroundStyle(entry.color)]} />
            </Button>
          ))}
          <Button onPress={onNewSpace} modifiers={[buttonStyle("plain"), accessibilityLabel(newSpace.label), accessibilityIdentifier(newSpace.id)]}>
            <Image systemName="plus" size={15} modifiers={[foregroundStyle("secondary"), frame({ width: 34, height: 34 }), contentShape(shapes.rectangle())]} />
          </Button>
        </HStack>
      </Host>
    </View>
  );
}
