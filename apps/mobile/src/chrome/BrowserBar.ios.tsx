import { Button, HStack, Host, Image, ScrollView, Text, useNativeState } from "@expo/ui/swift-ui";
import {
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  padding,
  tint,
  truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import * as swiftUI from "@expo/ui/swift-ui/modifiers";
import { useEffect, type JSX } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { useT } from "@/i18n";

import {
  barButtons,
  barInsecure,
  barLoading,
  barNewTab,
  barProgressTab,
  barSite,
  type BarButton,
  type BarSpace,
  type BrowserBarProps,
} from "./BrowserBar.types";
import { GlassIconButton } from "./GlassIconButton";
import { LoadProgress } from "./LoadProgress";
import { SpaceScrub } from "./SpaceScrub";
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
        <SpacesCapsule
          spaces={props.spaces}
          onSelect={props.onSelectSpace}
          newSpace={search}
          switchLabel={(name) => t("tabs.switchSpace", { name })}
          scrubHint={t("tabs.scrubSpacesHint")}
        />
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
        <LoadProgress tabId={barProgressTab(props)} loading={barLoading(props)} />
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

/** Each space's square in the capsule, and the room between them. */
const SPACE_SLOT = 34;
const SPACE_SPACING = 2;

/** What the bar keeps beside the capsule: the screen's edges, the two round glass buttons and the gaps between. */
const BAR_BESIDE = 2 * 12 + 2 * 52 + 2 * 12;

/**
 * The tab view's spaces between archive and new tab, in one glass capsule: each space's emoji or dot, the one showing
 * larger. More spaces than fit scroll inside the capsule, which never grows past the bar. Holding them and sliding moves
 * between spaces (SpaceScrub).
 */
function SpacesCapsule({
  spaces,
  onSelect,
  newSpace,
  switchLabel,
  scrubHint,
}: {
  spaces: readonly BarSpace[];
  onSelect: (id: string) => void;
  newSpace: BarButton;
  switchLabel: (name: string) => string;
  scrubHint: string;
}): JSX.Element {
  const select = useStableCallback(onSelect);
  const onNewSpace = useStableCallback(newSpace.onPress);
  const { width } = useWindowDimensions();
  // The capsule's padding and the + button take their share; the spaces get the rest.
  const room = width - BAR_BESIDE - 2 * 10 - SPACE_SLOT - SPACE_SPACING;
  const needed = spaces.length * (SPACE_SLOT + SPACE_SPACING);
  // The space showing scrolls into view when it changes, as Android's capsule does.
  const activeId = spaces.find((entry) => entry.active)?.id ?? null;
  const scrolledTo = useNativeState<string | null>(activeId);

  useEffect(() => {
    scrolledTo.set(activeId);
  }, [activeId, scrolledTo]);

  const buttons = spaces.map((entry) => (
    <Button
      key={entry.id}
      onPress={() => select(entry.id)}
      modifiers={[
        buttonStyle("plain"),
        swiftUI.id(entry.id),
        accessibilityLabel(switchLabel(entry.label)),
        swiftUI.accessibilityHint(scrubHint),
        accessibilityIdentifier(`bar-space-${entry.id}`),
      ]}
    >
      {/* The whole 34 pt square takes the tap, not only the emoji or the dot. */}
      {entry.icon ? (
        <Text
          modifiers={[
            font({ size: entry.active ? 20 : 15 }),
            swiftUI.opacity(entry.active ? 1 : 0.55),
            frame({ width: 34, height: 34 }),
            swiftUI.contentShape(swiftUI.shapes.rectangle()),
          ]}
        >
          {entry.icon}
        </Text>
      ) : (
        <Image
          systemName={entry.active ? "app.fill" : "circle.fill"}
          size={entry.active ? 18 : 9}
          modifiers={[foregroundStyle(entry.color), frame({ width: 34, height: 34 }), swiftUI.contentShape(swiftUI.shapes.rectangle())]}
        />
      )}
    </Button>
  ));

  // The spaces start after the capsule's padding and run as wide as they show.
  const area = { left: 10, width: Math.min(needed, room) };

  return (
    <SpaceScrub spaces={spaces} area={area} onSelect={select}>
      <View testID="bar-spaces" collapsable={false}>
        <Host matchContents>
          <HStack
            spacing={SPACE_SPACING}
            modifiers={[padding({ horizontal: 10, vertical: 6 }), glassEffect({ glass: { variant: "regular" }, ["shape"]: "capsule" })]}
          >
            {needed > room ? (
              <ScrollView
                axes="horizontal"
                showsIndicators={false}
                modifiers={[frame({ width: Math.max(SPACE_SLOT, room), height: SPACE_SLOT }), swiftUI.scrollPosition(scrolledTo, { anchor: "center" })]}
              >
                <HStack spacing={SPACE_SPACING} modifiers={[swiftUI.scrollTargetLayout()]}>
                  {buttons}
                </HStack>
              </ScrollView>
            ) : (
              buttons
            )}
            <Button onPress={onNewSpace} modifiers={[buttonStyle("plain"), accessibilityLabel(newSpace.label), accessibilityIdentifier(newSpace.id)]}>
              <Image
                systemName="plus"
                size={15}
                modifiers={[foregroundStyle("secondary"), frame({ width: 34, height: 34 }), swiftUI.contentShape(swiftUI.shapes.rectangle())]}
              />
            </Button>
          </HStack>
        </Host>
      </View>
    </SpaceScrub>
  );
}
