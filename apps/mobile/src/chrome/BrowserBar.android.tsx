import { useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type ComponentRef, type JSX } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { LoadProgress } from "./LoadProgress";
import { MaterialSymbol, type MaterialSymbolName } from "./MaterialSymbol";
import { SpaceScrub } from "./SpaceScrub";
import { SwipeUp } from "./SwipeUp";
import { TabCount } from "./TabCount";
import { Text } from "./Text";

// Same layout as iOS, drawn the way Arc Search does on Android: flat translucent buttons with a hairline edge.
function BarPressable({
  button,
  icon,
  wide = false,
  text,
  insecure = false,
  leading,
  privately = false,
}: {
  button: BarButton;
  icon: MaterialSymbolName;
  wide?: boolean;
  /** Shown in place of the icon. */
  text?: string;
  /** A warning before the text. */
  insecure?: boolean;
  /** An icon before the text. */
  leading?: MaterialSymbolName;
  privately?: boolean;
}): JSX.Element {
  const themeForeground = useThemeColor("foreground");
  const foreground = privately ? "#F4F4F5" : themeForeground;
  const danger = useThemeColor("danger");

  return (
    <Pressable
      testID={button.id}
      accessibilityRole="button"
      accessibilityLabel={button.label}
      onPress={button.onPress}
      onLongPress={button.onLongPress}
      className={
        privately
          ? "h-[52px] items-center justify-center rounded-full border border-white/10 bg-neutral-900/95 active:bg-neutral-800/95"
          : "h-[52px] items-center justify-center rounded-full border border-black/10 bg-white/90 active:bg-neutral-200/90 dark:border-white/10 dark:bg-neutral-900/90 dark:active:bg-neutral-800/90"
      }
      style={{ width: wide ? (text ? 172 : 128) : 52 }}
    >
      {text ? (
        <View className="flex-row items-center gap-1 px-3.5">
          {insecure ? <MaterialSymbol name="error" color={danger} size={16} /> : null}
          {leading ? <MaterialSymbol name={leading} color={foreground} size={20} /> : null}
          <Text numberOfLines={1} className="shrink" variant="callout" weight="medium" color={foreground}>
            {text}
          </Text>
        </View>
      ) : (
        <MaterialSymbol name={icon} color={foreground} size={22} />
      )}
      {button.badge ? <TabCount count={button.badge} /> : null}
    </Pressable>
  );
}

export function BrowserBar(props: BrowserBarProps): JSX.Element {
  const t = useT();
  const [left, search, right] = barButtons(props, t);

  if (props.mode === "tabs") {
    return (
      <View className="flex-row items-center justify-center gap-3">
        <BarPressable button={left} icon={left.icon} />
        <SpacesCapsule
          spaces={props.spaces}
          onSelect={props.onSelectSpace}
          newSpace={search}
          switchLabel={(name) => t("tabs.switchSpace", { name })}
          scrubHint={t("tabs.scrubSpacesHint")}
        />
        <BarPressable button={right} icon={right.icon} />
      </View>
    );
  }

  return (
    <View className="flex-row items-center justify-center gap-3">
      <SwipeUp onSwipeUp={props.mode === "page" ? props.onTabsSwipeUp : undefined}>
        <BarPressable button={left} icon={left.icon} privately={props.privately} />
      </SwipeUp>
      <Animated.View style={props.capsuleStyle}>
        <BarPressable
          button={search}
          icon="search"
          wide
          text={barNewTab(props) ? t("bar.newTab") : barSite(props)}
          leading={barNewTab(props) ? "add" : undefined}
          insecure={barInsecure(props)}
          privately={props.privately}
        />
        {/* The load's progress runs along the capsule's edge (A6). */}
        <LoadProgress tabId={barProgressTab(props)} loading={barLoading(props)} />
      </Animated.View>
      <BarPressable button={right} icon={right.icon} privately={props.privately} />
    </View>
  );
}

/** Each space's square in the capsule. */
const SPACE_SLOT = 36;

/**
 * The tab view's spaces between archive and new tab: each space's emoji or a dot in its colour, the one showing larger.
 * More spaces than fit scroll inside the capsule, which never grows past the bar, and the one showing scrolls into
 * view. Holding them and sliding moves between spaces (SpaceScrub).
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
  const muted = useThemeColor("muted");
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const [area, setArea] = useState({ left: 0, width: 1 });
  const activeIndex = spaces.findIndex((entry) => entry.active);

  useEffect(() => {
    if (activeIndex >= 0) list.current?.scrollTo({ x: Math.max(0, (activeIndex - 1) * SPACE_SLOT), animated: true });
  }, [activeIndex]);

  return (
    <SpaceScrub spaces={spaces} area={area} onSelect={onSelect} style={{ flexShrink: 1, minWidth: 0 }}>
      <View
        className="h-[52px] shrink flex-row items-center rounded-full border border-black/10 bg-white/90 px-2 dark:border-white/10 dark:bg-neutral-900/90"
        style={{ minWidth: 0 }}
      >
        <ScrollView
          ref={list}
          testID="bar-spaces"
          onLayout={(event) => setArea({ left: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width })}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 1 }}
          contentContainerStyle={{ alignItems: "center" }}
        >
          {spaces.map((entry) => (
            <Pressable
              key={entry.id}
              testID={`bar-space-${entry.id}`}
              accessibilityRole="button"
              accessibilityLabel={switchLabel(entry.label)}
              accessibilityHint={scrubHint}
              accessibilityState={{ selected: entry.active }}
              onPress={() => onSelect(entry.id)}
              className="h-11 items-center justify-center"
              style={{ width: SPACE_SLOT }}
            >
              {entry.icon ? (
                <Text style={{ fontSize: entry.active ? 20 : 15, lineHeight: 24, opacity: entry.active ? 1 : 0.55 }}>{entry.icon}</Text>
              ) : (
                <View
                  style={
                    entry.active
                      ? { width: 18, height: 18, borderRadius: 6, backgroundColor: entry.color }
                      : { width: 9, height: 9, borderRadius: 4.5, backgroundColor: entry.color, opacity: 0.75 }
                  }
                />
              )}
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          testID={newSpace.id}
          accessibilityRole="button"
          accessibilityLabel={newSpace.label}
          onPress={newSpace.onPress}
          className="h-11 w-9 items-center justify-center"
        >
          <MaterialSymbol name="add" color={muted} size={18} />
        </Pressable>
      </View>
    </SpaceScrub>
  );
}
