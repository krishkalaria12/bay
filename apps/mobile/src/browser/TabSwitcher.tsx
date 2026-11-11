import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import { useRef, type ComponentRef, type JSX } from "react";
import { Image, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tick } from "@/chrome/haptics";
import { Icon } from "@/chrome/Icon";
import { Text } from "@/chrome/Text";
import { useT } from "@/i18n";
import { spaceName } from "@/store/spaceName";
import type { BrowserFolder, BrowserSpace, BrowserTab, SpaceColor } from "@/store/types";
import { SiteIcon } from "./SiteIcon";
import type { Frame } from "./TabZoom";

export interface TabSwitcherProps {
  tabs: readonly BrowserTab[];
  activeTabId: string;
  /** The user picked a card; the switcher reports where the card sits, so the page can grow out of it (A1). */
  onPick: (tab: BrowserTab, frame: Frame) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  /** Private pages are hidden while private tabs are locked. */
  privateLocked: boolean;
  /** Spaces (B21): one visible stack at a time, like desktop. */
  spaces: readonly BrowserSpace[];
  activeSpaceId: string;
  onSelectSpace: (id: string) => void;
  /** Folders inside the active space; the active one filters the stack. */
  folders: readonly BrowserFolder[];
  activeFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
}

const SPACE_COLORS: Record<SpaceColor, string> = {
  gray: "#9CA3AF",
  blue: "#3B82F6",
  green: "#22C55E",
  orange: "#F97316",
  red: "#EF4444",
  violet: "#8B5CF6",
};

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
  /** The safe distance from the screen's left edge; the stack sits this far in, so cards keep off the notch. */
  left: number;
}

/**
 * The iPhone app switcher's stack: the card in front sits in the middle, the next one peeks in from the right, and
 * the ones before it slide underneath to the left, smaller and dimmer. Every card follows the scroll on the UI thread.
 * Swipe a card up to close it.
 */
export function TabSwitcher({
  tabs,
  activeTabId,
  onPick,
  onClose,
  onCloseAll,
  privateLocked,
  spaces,
  activeSpaceId,
  onSelectSpace,
  folders,
  activeFolderId,
  onSelectFolder,
}: TabSwitcherProps): JSX.Element {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();
  // Landscape (B10) keeps the cards clear of the notch on either side, and turns them smaller and squarer so the
  // next one still peeks in from the right, like the switcher does in portrait.
  const innerWidth = width - insets.left - insets.right;
  const portrait = height >= width;
  const cardWidth = Math.round(innerWidth * (portrait ? 0.68 : 0.42));
  const cardHeight = Math.round(Math.min(height * (portrait ? 0.58 : 0.72), cardWidth * (portrait ? 2.05 : 1.35)));
  const layout: Layout = { width: innerWidth, left: insets.left, cardWidth, cardHeight, step: Math.round(cardWidth * STEP) };

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
      <View
        className="absolute inset-x-0 top-2 flex-row items-center justify-between px-5"
        style={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }}
      >
        <Text testID="tab-switcher-count" accessibilityRole="header" variant="headline">
          {tabs.length === 1 ? t("tabs.one") : t("tabs.count", { count: tabs.length })}
        </Text>
        {tabs.length > 1 ? (
          <Pressable
            testID="tab-switcher-archive-all"
            accessibilityRole="button"
            accessibilityLabel={t("tabs.archiveAllCount", { count: tabs.length })}
            onPress={onCloseAll}
            className="min-h-11 justify-center px-2 active:opacity-60"
          >
            <Text variant="callout" weight="medium" tone="muted">
              {t("tabs.archiveAll")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {/* Spaces (B21): one stack per space, rather than one flat list for every tab. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="absolute inset-x-0 top-16"
        style={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }}
      >
        <View className="flex-row gap-2">
          {spaces.map((space) => {
            const active = space.id === activeSpaceId;
            const name = spaceName(space, t);

            return (
              <Pressable
                key={space.id}
                testID={`space-chip-${space.id}`}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ selected: active }}
                onPress={() => onSelectSpace(space.id)}
                className="h-10 flex-row items-center gap-2 rounded-full px-4 active:opacity-60"
                style={{
                  backgroundColor: active ? `${SPACE_COLORS[space.color]}33` : undefined,
                  borderWidth: 1,
                  borderColor: active ? SPACE_COLORS[space.color] : muted + "55",
                }}
              >
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: SPACE_COLORS[space.color] }} />
                <Text variant="subhead" weight={active ? "semibold" : "medium"}>
                  {name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {/* Folders (B21) inside the active space: a filter across the stack. */}
      {folders.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="absolute inset-x-0 top-[7rem]"
          style={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }}
        >
          <View className="flex-row gap-2">
            <Pressable
              testID="folder-chip-all"
              accessibilityRole="button"
              accessibilityLabel={t("tabs.all")}
              accessibilityState={{ selected: activeFolderId === null }}
              onPress={() => onSelectFolder(null)}
              className="h-9 flex-row items-center rounded-full px-3 active:opacity-60"
              style={{
                backgroundColor: activeFolderId === null ? foreground + "14" : undefined,
                borderWidth: 1,
                borderColor: activeFolderId === null ? foreground : muted + "55",
              }}
            >
              <Text variant="footnote" weight={activeFolderId === null ? "semibold" : "medium"}>
                {t("tabs.all")}
              </Text>
            </Pressable>
            {folders.map((folder) => {
              const active = folder.id === activeFolderId;

              return (
                <Pressable
                  key={folder.id}
                  testID={`folder-chip-${folder.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={folder.name}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelectFolder(folder.id)}
                  className="h-9 flex-row items-center rounded-full px-3 active:opacity-60"
                  style={{ backgroundColor: active ? foreground + "14" : undefined, borderWidth: 1, borderColor: active ? foreground : muted + "55" }}
                >
                  <Text variant="footnote" weight={active ? "semibold" : "medium"}>
                    {folder.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
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
        contentContainerStyle={{ width: layout.width + (tabs.length - 1) * layout.step, height: cardHeight + 44 }}
      >
        {tabs.map((tab, index) => (
          <TabCard
            key={tab.id}
            tab={tab}
            index={index}
            count={tabs.length}
            layout={layout}
            scrollX={scrollX}
            active={tab.id === activeTabId}
            hidden={Boolean(tab.private && privateLocked)}
            onPick={onPick}
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
  count,
  layout,
  scrollX,
  active,
  hidden,
  onPick,
  onClose,
}: {
  tab: BrowserTab;
  index: number;
  /** How many cards the stack holds, so a reader hears where this one sits. */
  count: number;
  layout: Layout;
  scrollX: SharedValue<number>;
  active: boolean;
  hidden: boolean;
  onPick: (tab: BrowserTab, frame: Frame) => void;
  onClose: (id: string) => void;
}): JSX.Element {
  const muted = useThemeColor("muted");
  const t = useT();
  // A locked private tab's title stays hidden from screen readers too.
  const title = hidden ? t("tabs.locked") : tab.title || (tab.url ? displayUrl(tab.url) : t("tabs.newTab"));
  const position = t(tab.private ? "tabs.privatePosition" : "tabs.position", { index: index + 1, count });
  const { width, cardWidth, cardHeight, step, left } = layout;
  const lift = useSharedValue(0);
  // The card's frame on the screen, so the page can grow out of it (A1).
  const card = useRef<ComponentRef<typeof View>>(null);

  const close = () => {
    tick();
    onClose(tab.id);
  };

  // The card's place on the screen is measured, not worked out: the stack moves as it is swiped.
  const pick = () => {
    const measure = card.current?.measureInWindow;

    if (!measure) {
      onPick(tab, { x: 0, y: 0, width: cardWidth, height: cardHeight });

      return;
    }

    measure.call(card.current, (x: number, y: number, measuredWidth: number, measuredHeight: number) => {
      onPick(tab, { x, y, width: measuredWidth, height: measuredHeight });
    });
  };

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

    // The card sits clear of the notch side and stays put on screen while the scroll view moves its content: add the
    // scroll back, then place it. It is laid out where it sits when it is in front and moved from there, because Android
    // works out what is on screen (for TalkBack and the accessibility tree) from the layout box: a card moved wholly out
    // of a box at the stack's start went missing, the next card and its close button with it.
    return {
      transform: [{ translateX: scrollX.value - index * step + x }, { translateY: lift.value }, { scale }],
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
      <Animated.View style={[{ position: "absolute", left: index * step + left + (width - cardWidth) / 2, top: 0, width: cardWidth, zIndex: index }, style]}>
        <Animated.View className="mb-2 flex-row items-center gap-2 pl-1" style={header}>
          {/* The card below says all of this, so readers go from the card to its close button. */}
          {tab.private ? (
            <View
              testID={`tab-private-${index}`}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="flex-row items-center gap-1 rounded-full bg-neutral-900 px-2 py-0.5"
            >
              <Icon name="private" color="#F4F4F5" size={14} />
              <Text variant="micro" color={"#F4F4F5"}>
                {t("tabs.private")}
              </Text>
            </View>
          ) : null}
          {tab.url && !hidden ? <SiteIcon url={tab.url} size={18} /> : null}
          <Text
            numberOfLines={1}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="flex-1"
            variant="footnote"
            weight="medium"
          >
            {title}
          </Text>
          <Pressable
            testID={`tab-close-${index}`}
            accessibilityRole="button"
            accessibilityLabel={t("tabs.closeLabel", { title })}
            hitSlop={6}
            onPress={close}
            className="h-8 w-8 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
          >
            <Icon name="close" color={muted} size={16} />
          </Pressable>
        </Animated.View>
        <Pressable
          ref={card}
          testID={`tab-card-${index}`}
          accessibilityRole="button"
          accessibilityLabel={t("tabs.openLabel", { title })}
          // Which card this is, read after its title: "Tab 2 of 5".
          accessibilityValue={{ text: position }}
          accessibilityHint={t("tabs.swipeToClose")}
          accessibilityState={{ selected: active }}
          onPress={pick}
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
              <Text variant="footnote" tone="muted">
                {tab.url ? displayUrl(tab.url) : t("tabs.newTab")}
              </Text>
            </View>
          )}
          {/* Cards further back sit in shadow. */}
          <Animated.View pointerEvents="none" className="absolute inset-0 bg-black" style={shade} />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}
