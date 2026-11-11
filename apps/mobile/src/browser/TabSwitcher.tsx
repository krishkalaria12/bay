import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import { useRef, useState, type ComponentRef, type JSX } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
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
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { useBrowserStore } from "@/store/browser";
import { spaceName } from "@/store/spaceName";
import type { BrowserFolder, BrowserSpace, BrowserTab, SpaceColor } from "@/store/types";
import { SiteIcon } from "./SiteIcon";
import type { Frame } from "./TabZoom";
import { Wallpaper } from "./Wallpaper";

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

/** iOS lifts the cards off the wallpaper; Android draws them flat (no elevation, as Arc Search does). */
const CARD_LIFT = Platform.select({
  ios: { shadowColor: "#000000", shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  default: {},
});

/** The row above each card: its site, title and close button. */
const CARD_HEADER = 40;

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
  const t = useT();
  // Landscape (B10) keeps the cards clear of the notch on either side, and turns them smaller and squarer so the
  // next one still peeks in from the right, like the switcher does in portrait.
  const innerWidth = width - insets.left - insets.right;
  const portrait = height >= width;
  // The stack fills what the header and chips leave, measured, so the cards never run under them.
  const [stage, setStage] = useState(0);
  const cardWidth = Math.round(innerWidth * (portrait ? 0.68 : 0.42));
  const fits = stage ? stage - CARD_HEADER - space.lg : Infinity;
  const cardHeight = Math.round(Math.min(height * (portrait ? 0.58 : 0.72), cardWidth * (portrait ? 2.05 : 1.35), fits));
  const layout: Layout = { width: innerWidth, left: insets.left, cardWidth, cardHeight, step: Math.round(cardWidth * STEP) };

  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );

  const scrollX = useSharedValue(activeIndex * layout.step);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  const gutter = { paddingLeft: insets.left + space.gutter, paddingRight: insets.right + space.gutter };

  return (
    <View testID="tab-switcher" className="flex-1">
      <View className="flex-row items-center justify-between" style={[gutter, { paddingTop: space.sm, minHeight: 44 }]}>
        <Text testID="tab-switcher-count" accessibilityRole="header" variant="title">
          {tabs.length === 1 ? t("tabs.one") : t("tabs.count", { count: tabs.length })}
        </Text>
        {tabs.length > 1 ? (
          <PressFeedback
            testID="tab-switcher-archive-all"
            accessibilityRole="button"
            accessibilityLabel={t("tabs.archiveAllCount", { count: tabs.length })}
            onPress={onCloseAll}
            hitSlop={8}
            className="h-9 justify-center rounded-full bg-default"
            style={{ paddingHorizontal: space.md + 2 }}
          >
            <Text variant="subhead" weight="medium">
              {t("tabs.archiveAll")}
            </Text>
          </PressFeedback>
        ) : null}
      </View>
      {/* Spaces (B21): one stack per space, rather than one flat list for every tab. A lone space has nothing to switch
          to, so its chip would only take room. */}
      {spaces.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="grow-0"
          contentContainerStyle={[gutter, { gap: space.sm, paddingTop: space.md }]}
        >
          {spaces.map((entry) => (
            <Chip
              key={entry.id}
              testID={`space-chip-${entry.id}`}
              label={spaceName(entry, t)}
              active={entry.id === activeSpaceId}
              dot={SPACE_COLORS[entry.color]}
              onPress={() => onSelectSpace(entry.id)}
            />
          ))}
        </ScrollView>
      ) : null}
      {/* Folders (B21) inside the active space: a filter across the stack. */}
      {folders.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="grow-0"
          contentContainerStyle={[gutter, { gap: space.sm, paddingTop: space.sm }]}
        >
          <Chip testID="folder-chip-all" label={t("tabs.all")} active={activeFolderId === null} onPress={() => onSelectFolder(null)} />
          {folders.map((folder) => (
            <Chip
              key={folder.id}
              testID={`folder-chip-${folder.id}`}
              label={folder.name}
              active={folder.id === activeFolderId}
              onPress={() => onSelectFolder(folder.id)}
            />
          ))}
        </ScrollView>
      ) : null}
      <View className="flex-1 justify-center" onLayout={(event) => setStage(Math.round(event.nativeEvent.layout.height))}>
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
          contentContainerStyle={{ width: layout.width + (tabs.length - 1) * layout.step, height: cardHeight + CARD_HEADER }}
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
    </View>
  );
}

/** A space or folder to switch to: a quiet capsule, filled in when it is the one showing. */
function Chip({ testID, label, active, dot, onPress }: { testID: string; label: string; active: boolean; dot?: string; onPress: () => void }): JSX.Element {
  const background = useThemeColor("background");

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`h-9 flex-row items-center rounded-full ${active ? "bg-foreground" : "bg-default"}`}
      style={{ gap: space.sm, paddingHorizontal: space.md + 2 }}
    >
      {dot ? <View className="h-2 w-2 rounded-full" style={{ backgroundColor: dot }} /> : null}
      <Text variant="subhead" weight={active ? "semibold" : "medium"} color={active ? background : undefined}>
        {label}
      </Text>
    </PressFeedback>
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
  const wallpaper = useBrowserStore((state) => state.data.preferences.wallpaper);
  const wallpaperPhoto = useBrowserStore((state) => state.data.preferences.wallpaperPhoto);
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
        <Animated.View
          className="flex-row items-center"
          style={[{ height: CARD_HEADER - space.sm, marginBottom: space.sm, gap: space.sm, paddingLeft: space.xs }, header]}
        >
          {/* The card below says all of this, so readers go from the card to its close button. */}
          {tab.private ? (
            <View
              testID={`tab-private-${index}`}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="h-6 flex-row items-center rounded-full bg-neutral-900"
              style={{ gap: space.xs, paddingHorizontal: space.sm }}
            >
              <Icon name="private" color="#F4F4F5" size={iconSize.inline} />
              <Text variant="micro" color={"#F4F4F5"}>
                {t("tabs.private")}
              </Text>
            </View>
          ) : null}
          {tab.url && !hidden ? <SiteIcon url={tab.url} size={20} /> : null}
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
            className="h-7 w-7 items-center justify-center rounded-full bg-default"
          >
            <Icon name="close" color={muted} size={iconSize.inline} />
          </Pressable>
        </Animated.View>
        {/* The lift: a soft shadow on iOS; Android's surfaces stay flat, with only their hairline. */}
        <View style={[{ borderRadius: radius.panel }, CARD_LIFT]}>
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
            className={tab.private ? "overflow-hidden bg-neutral-900" : "overflow-hidden bg-white dark:bg-neutral-900"}
            style={{ height: cardHeight, borderRadius: radius.panel }}
          >
            {hidden ? (
              <View className="flex-1 items-center justify-center">
                <Icon name="lock" color="#A1A1AA" size={28} />
              </View>
            ) : tab.snapshot ? (
              <Image source={{ uri: tab.snapshot }} resizeMode="cover" style={{ width: cardWidth, height: cardHeight }} />
            ) : tab.url ? (
              <View className="flex-1 items-center justify-center" style={{ gap: space.md }}>
                <SiteIcon url={tab.url} size={44} />
                <Text variant="footnote" tone="muted">
                  {displayUrl(tab.url)}
                </Text>
              </View>
            ) : (
              // A new tab shows the start page, so its card shows the start page's wallpaper.
              <View className="flex-1 items-center justify-end" style={{ paddingBottom: space.xl }}>
                {tab.private ? null : <Wallpaper id={wallpaper} photo={wallpaperPhoto} scale={0.6} />}
                <Text variant="footnote" weight="medium" tone="muted">
                  {t("tabs.newTab")}
                </Text>
              </View>
            )}
            {/* Cards further back sit in shadow. */}
            <Animated.View pointerEvents="none" className="absolute inset-0 bg-black" style={shade} />
            {/* The edge sits over the page's picture: the current tab gets the accent, the others a hairline. */}
            <View
              pointerEvents="none"
              className={
                active
                  ? "absolute inset-0 border-accent"
                  : tab.private
                    ? "absolute inset-0 border-white/10"
                    : "absolute inset-0 border-black/10 dark:border-white/10"
              }
              style={{ borderRadius: radius.panel, borderWidth: active ? 2.5 : StyleSheet.hairlineWidth }}
            />
          </Pressable>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
