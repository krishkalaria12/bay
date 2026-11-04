import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Image, Pressable, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { Icon } from "@/chrome/Icon";
import type { BrowserTab } from "@/store/types";
import { SiteIcon } from "./SiteIcon";

export interface TabSwitcherProps {
  tabs: readonly BrowserTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  /** Private pages are hidden while private tabs are locked. */
  privateLocked: boolean;
}

/** How far the stack scrolls per card, as a share of the card's width. */
const STEP = 0.56;
/** A card dragged up this far (share of its height), or flicked up this fast, closes. */
const CLOSE_DISTANCE = 0.28;
const CLOSE_VELOCITY = -900;

interface Layout {
  width: number;
  cardWidth: number;
  cardHeight: number;
  step: number;
}

/**
 * The iPhone app switcher's stack: the card in front sits in the middle, the next one peeks in from the right, and
 * the ones before it slide underneath to the left, smaller and dimmer. Every card follows the scroll on the UI thread.
 * Swipe a card up to close it.
 */
export function TabSwitcher({ tabs, activeTabId, onSelect, onClose, onCloseAll, privateLocked }: TabSwitcherProps): JSX.Element {
  const { width, height } = useWindowDimensions();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const cardWidth = Math.round(width * 0.68);
  const cardHeight = Math.round(Math.min(height * 0.58, cardWidth * 2.05));
  const layout: Layout = { width, cardWidth, cardHeight, step: Math.round(cardWidth * STEP) };
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  const scrollX = useSharedValue(activeIndex * layout.step);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  return (
    <View testID="tab-switcher" className="flex-1 justify-center">
      <View className="absolute inset-x-0 top-2 flex-row items-center justify-between px-5">
        <Text testID="tab-switcher-count" accessibilityRole="header" style={{ color: foreground, fontSize: 17, fontWeight: "600" }}>
          {tabs.length === 1 ? "1 tab" : `${tabs.length} tabs`}
        </Text>
        {tabs.length > 1 ? (
          <Pressable
            testID="tab-switcher-archive-all"
            accessibilityRole="button"
            accessibilityLabel={`Archive all ${tabs.length} tabs`}
            onPress={onCloseAll}
            className="min-h-11 justify-center px-2 active:opacity-60"
          >
            <Text style={{ color: muted, fontSize: 15, fontWeight: "500" }}>Archive all</Text>
          </Pressable>
        ) : null}
      </View>
      <Animated.ScrollView
        horizontal
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentOffset={{ x: activeIndex * layout.step, y: 0 }}
        showsHorizontalScrollIndicator={false}
        // Lands on a card after a fling of any length, like the app switcher.
        snapToInterval={layout.step}
        decelerationRate="normal"
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ width: width + (tabs.length - 1) * layout.step, height: cardHeight + 44 }}
      >
        {tabs.map((tab, index) => (
          <TabCard
            key={tab.id}
            tab={tab}
            index={index}
            layout={layout}
            scrollX={scrollX}
            active={tab.id === activeTabId}
            hidden={Boolean(tab.private && privateLocked)}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

function TabCard({
  tab,
  index,
  layout,
  scrollX,
  active,
  hidden,
  onSelect,
  onClose,
}: {
  tab: BrowserTab;
  index: number;
  layout: Layout;
  scrollX: SharedValue<number>;
  active: boolean;
  hidden: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const title = tab.title || (tab.url ? displayUrl(tab.url) : "New tab");
  const { width, cardWidth, cardHeight, step } = layout;
  const lift = useSharedValue(0);

  const close = () => onClose(tab.id);
  const pan = usePanGesture({
    // Up only: sideways drags scroll the stack, taps open the tab.
    activeOffsetY: [-14, 14],
    failOffsetX: [-14, 14],
    onUpdate: (event) => {
      "worklet";
      // Drags down resist, so a card only leaves upwards.
      lift.value = event.translationY < 0 ? event.translationY : event.translationY * 0.2;
    },
    onDeactivate: (event) => {
      "worklet";
      if (!event.canceled && (event.translationY < -cardHeight * CLOSE_DISTANCE || event.velocityY < CLOSE_VELOCITY)) {
        lift.value = withTiming(-cardHeight * 1.6, { duration: 200 }, () => scheduleOnRN(close));
      } else {
        lift.value = withTiming(0, { duration: 180 });
      }
    },
  });

  const style = useAnimatedStyle(() => {
    // 0 is the card in front, negative ones are behind it (left), positive ones still to come (right).
    const position = index - scrollX.value / step;
    const x = position >= 0 ? position * cardWidth * 1.04 : position * cardWidth * 0.3;
    const scale = interpolate(position, [-3, 0], [0.84, 1], Extrapolation.CLAMP);
    // The card stays put on screen while the scroll view moves its content: add the scroll back, then place it.
    return {
      transform: [{ translateX: scrollX.value + (width - cardWidth) / 2 + x }, { translateY: lift.value }, { scale }],
      opacity: interpolate(lift.value, [-cardHeight, 0], [0, 1], Extrapolation.CLAMP),
    };
  });
  // Only the cards in front and to come keep their title and close button; ones sliding under would show through.
  const header = useAnimatedStyle(() => ({
    opacity: interpolate(index - scrollX.value / step, [-0.6, 0], [0, 1], Extrapolation.CLAMP),
  }));
  const shade = useAnimatedStyle(() => ({
    opacity: interpolate(index - scrollX.value / step, [-3, 0], [0.45, 0], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: cardWidth, zIndex: index }, style]}>
        <Animated.View className="mb-2 flex-row items-center gap-2 pl-1" style={header}>
          {tab.private ? (
            <View testID={`tab-private-${index}`} className="flex-row items-center gap-1 rounded-full bg-neutral-900 px-2 py-0.5">
              <Icon name="private" color="#F4F4F5" size={14} />
              <Text style={{ color: "#F4F4F5", fontSize: 11, fontWeight: "600" }}>Private</Text>
            </View>
          ) : null}
          {tab.url && !hidden ? <SiteIcon url={tab.url} size={18} /> : null}
          <Text numberOfLines={1} className="flex-1" style={{ color: foreground, fontSize: 13, fontWeight: "500" }}>
            {hidden ? "Locked" : title}
          </Text>
          <Pressable
            testID={`tab-close-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`Close ${title}`}
            hitSlop={6}
            onPress={close}
            className="h-8 w-8 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
          >
            <Icon name="close" color={muted} size={16} />
          </Pressable>
        </Animated.View>
        <Pressable
          testID={`tab-card-${index}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          accessibilityHint="Swipe up to close"
          accessibilityState={{ selected: active }}
          onPress={() => onSelect(tab.id)}
          className={
            tab.private
              ? "overflow-hidden rounded-[22px] border border-white/10 bg-neutral-900"
              : "overflow-hidden rounded-[22px] border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900"
          }
          style={{ height: cardHeight, borderWidth: active ? 2 : 1 }}
        >
          {hidden ? (
            <View className="flex-1 items-center justify-center">
              <Icon name="lock" color="#A1A1AA" size={28} />
            </View>
          ) : tab.snapshot ? (
            <Image source={{ uri: tab.snapshot }} resizeMode="cover" style={{ width: cardWidth, height: cardHeight }} />
          ) : (
            <View className="flex-1 items-center justify-center gap-3">
              {tab.url ? <SiteIcon url={tab.url} size={44} /> : null}
              <Text style={{ color: muted, fontSize: 13 }}>{tab.url ? displayUrl(tab.url) : "New tab"}</Text>
            </View>
          )}
          {/* Cards further back sit in shadow. */}
          <Animated.View pointerEvents="none" className="absolute inset-0 bg-black" style={shade} />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}
