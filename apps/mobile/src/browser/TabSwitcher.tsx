import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import { useRef, useState, type ComponentRef, type JSX } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { tick } from "@/chrome/haptics";
import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { useBrowserStore } from "@/store/browser";
import { spaceName } from "@/store/spaceName";
import type { BrowserFolder, BrowserSpace, BrowserTab, PinnedSite, SpaceColor } from "@/store/types";
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
  /** Spaces (B21): one space at a time, like desktop; a sideways swipe goes to the next or the one before. */
  spaces: readonly BrowserSpace[];
  activeSpaceId: string;
  onSelectSpace: (id: string) => void;
  /** Folders inside the active space; the active one narrows the grid. */
  folders: readonly BrowserFolder[];
  activeFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  /** The pinned sites, as the space's favourites along its top. */
  pins: readonly PinnedSite[];
  onOpenSite: (url: string) => void;
  onSettings: () => void;
  /** Opens the space's emoji, to change it. */
  onChangeIcon: () => void;
}

/** A space's colour: its glyph, its dot in the bar and the wash at the top of its page. */
export const SPACE_COLORS: Record<SpaceColor, string> = {
  gray: "#9CA3AF",
  blue: "#3B82F6",
  green: "#22C55E",
  orange: "#F97316",
  red: "#EF4444",
  violet: "#8B5CF6",
};

/** Three cards across, as a sidebar of tiles. */
const COLUMNS = 3;
const GAP = 10;

/** A card is a little taller than wide, like a phone's page shrunk down. */
const CARD_RATIO = 1.32;

/** How far a sideways swipe goes, or how fast, before it changes space. */
const SPACE_SWIPE = 80;

const SPACE_FLING = 600;

/**
 * The tab view as a space's page: its name over a wash of its colour, the pinned sites as favourites, its folders, and
 * its tabs as a grid of cards. A sideways swipe moves to the next space; the bar below switches spaces too.
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
  pins,
  onOpenSite,
  onSettings,
  onChangeIcon,
}: TabSwitcherProps): JSX.Element {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const t = useT();
  const muted = useThemeColor("muted");
  const current = spaces.find((entry) => entry.id === activeSpaceId) ?? spaces[0];
  const color = SPACE_COLORS[current?.color ?? "gray"];
  const name = current ? spaceName(current, t) : "";
  const inner = width - insets.left - insets.right - 2 * space.gutter;
  const cardWidth = Math.floor((inner - GAP * (COLUMNS - 1)) / COLUMNS);
  const shift = useSharedValue(0);
  const index = spaces.findIndex((entry) => entry.id === activeSpaceId);

  const step = (direction: 1 | -1) => {
    const next = spaces[index + direction];

    if (!next) return;
    tick();
    onSelectSpace(next.id);
  };

  const swipe = usePanGesture({
    // Sideways only: the page scrolls up and down, and cards take taps.
    activeOffsetX: [-24, 24],
    failOffsetY: [-12, 12],
    enabled: spaces.length > 1,
    onUpdate: (event) => {
      "worklet";
      shift.value = event.translationX * 0.35;
    },
    onDeactivate: (event) => {
      "worklet";
      const far = Math.abs(event.translationX) > SPACE_SWIPE || Math.abs(event.velocityX) > SPACE_FLING;

      if (!event.canceled && far) scheduleOnRN(step, event.translationX < 0 ? 1 : -1);
      shift.value = withTiming(0, { duration: 180 });
    },
  });

  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: shift.value }] }));
  const gutter = { paddingLeft: insets.left + space.gutter, paddingRight: insets.right + space.gutter };

  return (
    <View testID="tab-switcher" className="flex-1">
      <SpaceWash color={color} />
      <GestureDetector gesture={swipe}>
        <Animated.View className="flex-1" style={moving}>
          <ScrollView contentContainerStyle={[gutter, { paddingTop: space.sm, paddingBottom: space.xl, gap: space.lg }]} showsVerticalScrollIndicator={false}>
            <View className="flex-row items-center" style={{ gap: space.sm, minHeight: 44 }}>
              <PressFeedback
                testID="tab-switcher-icon"
                accessibilityRole="button"
                accessibilityLabel={t("space.icon.change", { name })}
                onPress={onChangeIcon}
                hitSlop={6}
              >
                <SpaceGlyph color={color} name={name} icon={current?.icon ?? null} size={30} />
              </PressFeedback>
              <Text testID="tab-switcher-space" accessibilityRole="header" numberOfLines={1} variant="title" weight="bold" className="flex-1">
                {name}
              </Text>
              <PressFeedback
                testID="tab-switcher-settings"
                accessibilityRole="button"
                accessibilityLabel={t("bar.settings")}
                onPress={onSettings}
                hitSlop={6}
                className="h-10 w-10 items-center justify-center rounded-full bg-default"
              >
                <Icon name="settings" color={muted} size={iconSize.small} />
              </PressFeedback>
            </View>

            {pins.length ? (
              <View className="flex-row flex-wrap" style={{ gap: GAP }}>
                {pins.slice(0, COLUMNS * 2).map((pin, at) => (
                  <PressFeedback
                    key={pin.id}
                    testID={`tab-pin-${at}`}
                    accessibilityRole="button"
                    accessibilityLabel={pin.title || displayUrl(pin.url)}
                    onPress={() => onOpenSite(pin.url)}
                    className="items-center justify-center bg-default"
                    style={{ width: cardWidth, height: 64, borderRadius: radius.tile }}
                  >
                    <SiteIcon url={pin.url} size={30} />
                  </PressFeedback>
                ))}
              </View>
            ) : null}

            {folders.length ? (
              <View style={{ gap: 2 }}>
                <FolderRow testID="folder-chip-all" icon="tabs" label={t("tabs.all")} active={activeFolderId === null} onPress={() => onSelectFolder(null)} />
                {folders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    testID={`folder-chip-${folder.id}`}
                    icon="folder"
                    label={folder.name}
                    active={folder.id === activeFolderId}
                    onPress={() => onSelectFolder(folder.id)}
                  />
                ))}
              </View>
            ) : null}

            <View className="flex-row items-center" style={{ gap: space.md }}>
              <Text testID="tab-switcher-count" variant="footnote" weight="medium" tone="muted">
                {tabs.length === 1 ? t("tabs.one") : t("tabs.count", { count: tabs.length })}
              </Text>
              <View className="flex-1 bg-foreground/10" style={{ height: StyleSheet.hairlineWidth }} />
              {tabs.length > 1 ? (
                <PressFeedback
                  testID="tab-switcher-archive-all"
                  accessibilityRole="button"
                  accessibilityLabel={t("tabs.archiveAllCount", { count: tabs.length })}
                  onPress={onCloseAll}
                  hitSlop={8}
                >
                  <Text variant="footnote" weight="medium" tone="muted">
                    {t("tabs.clear")}
                  </Text>
                </PressFeedback>
              ) : null}
            </View>

            <View className="flex-row flex-wrap" style={{ gap: GAP, rowGap: space.lg }}>
              {tabs.map((tab, at) => (
                <TabCard
                  key={tab.id}
                  tab={tab}
                  index={at}
                  count={tabs.length}
                  width={cardWidth}
                  active={tab.id === activeTabId}
                  hidden={Boolean(tab.private && privateLocked)}
                  onPick={onPick}
                  onClose={onClose}
                />
              ))}
            </View>
          </ScrollView>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** The space's colour washing down from the top of its page, over the wallpaper. */
function SpaceWash({ color }: { color: string }): JSX.Element {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="space-wash" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.34} />
          <Stop offset="0.55" stopColor={color} stopOpacity={0.08} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#space-wash)" />
    </Svg>
  );
}

/** A space's mark: its emoji, or its first letter on its colour in a rounded square. */
export function SpaceGlyph({ color, name, icon, size }: { color: string; name: string; icon: string | null; size: number }): JSX.Element {
  if (icon) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="items-center justify-center"
        style={{ width: size, height: size }}
      >
        <Text style={{ fontSize: size * 0.82, lineHeight: size }}>{icon}</Text>
      </View>
    );
  }

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center"
      style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color }}
    >
      <Text weight="bold" color="#FFFFFF" style={{ fontSize: size * 0.5, lineHeight: size * 0.62 }}>
        {(name.trim()[0] ?? "•").toUpperCase()}
      </Text>
    </View>
  );
}

/** A folder in the space, as a row; the one showing is filled in. */
function FolderRow({
  testID,
  icon,
  label,
  active,
  onPress,
}: {
  testID: string;
  icon: "folder" | "tabs";
  label: string;
  active: boolean;
  onPress: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`flex-row items-center ${active ? "bg-default" : ""}`}
      style={{ minHeight: 40, gap: space.md, paddingHorizontal: space.sm, borderRadius: radius.control }}
    >
      <Icon name={icon} color={foreground} size={iconSize.small} />
      <Text variant="callout" weight={active ? "semibold" : "regular"} numberOfLines={1} className="flex-1">
        {label}
      </Text>
    </PressFeedback>
  );
}

/** iOS lifts the cards off the wallpaper; Android draws them flat (no elevation, as Arc Search does). */
const CARD_LIFT = Platform.select({
  ios: { shadowColor: "#000000", shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  default: {},
});

function TabCard({
  tab,
  index,
  count,
  width,
  active,
  hidden,
  onPick,
  onClose,
}: {
  tab: BrowserTab;
  index: number;
  /** How many cards the grid holds, so a reader hears where this one sits. */
  count: number;
  width: number;
  active: boolean;
  hidden: boolean;
  onPick: (tab: BrowserTab, frame: Frame) => void;
  onClose: (id: string) => void;
}): JSX.Element {
  const muted = useThemeColor("muted");
  const t = useT();
  // A locked private tab's title stays hidden from screen readers too.
  const title = hidden ? t("tabs.locked") : tab.title || (tab.url ? displayUrl(tab.url) : t("tabs.newTab"));

  const site =
    hidden || !tab.url
      ? title
      : displayUrl(tab.url)
          .replace(/^www\./, "")
          .split("/")[0]!;

  const position = t(tab.private ? "tabs.privatePosition" : "tabs.position", { index: index + 1, count });
  const height = Math.round(width * CARD_RATIO);
  const wallpaper = useBrowserStore((state) => state.data.preferences.wallpaper);
  const wallpaperPhoto = useBrowserStore((state) => state.data.preferences.wallpaperPhoto);
  // The card's frame on the screen, so the page can grow out of it (A1).
  const card = useRef<ComponentRef<typeof View>>(null);
  const [closing, setClosing] = useState(false);

  const close = () => {
    tick();
    setClosing(true);
    onClose(tab.id);
  };

  // The card's place is measured rather than worked out: the grid scrolls.
  const pick = () => {
    const measure = card.current?.measureInWindow;

    if (!measure) {
      onPick(tab, { x: 0, y: 0, width, height });

      return;
    }

    measure.call(card.current, (x: number, y: number, measuredWidth: number, measuredHeight: number) => {
      onPick(tab, { x, y, width: measuredWidth, height: measuredHeight });
    });
  };

  return (
    <View style={{ width, gap: space.xs, opacity: closing ? 0.4 : 1 }}>
      <View style={[{ borderRadius: radius.tile }, CARD_LIFT]}>
        <Pressable
          ref={card}
          testID={`tab-card-${index}`}
          accessibilityRole="button"
          accessibilityLabel={t("tabs.openLabel", { title })}
          // Which card this is, read after its title: "Tab 2 of 5".
          accessibilityValue={{ text: position }}
          accessibilityState={{ selected: active }}
          onPress={pick}
          className={tab.private ? "overflow-hidden bg-neutral-900" : "overflow-hidden bg-white dark:bg-neutral-900"}
          style={{ height, borderRadius: radius.tile }}
        >
          {hidden ? (
            <View className="flex-1 items-center justify-center">
              <Icon name="lock" color="#A1A1AA" size={22} />
            </View>
          ) : tab.snapshot ? (
            <Image source={{ uri: tab.snapshot }} resizeMode="cover" style={{ width, height }} />
          ) : tab.url ? (
            <View className="flex-1 items-center justify-center">
              <SiteIcon url={tab.url} size={32} />
            </View>
          ) : (
            // A new tab shows the start page, so its card shows the start page's wallpaper.
            <View className="flex-1 items-center justify-end" style={{ paddingBottom: space.md }}>
              {tab.private ? null : <Wallpaper id={wallpaper} photo={wallpaperPhoto} scale={0.4} />}
              <Icon name="add" color={muted} size={iconSize.small} />
            </View>
          )}
          {/* The current tab gets the accent edge, the others a hairline. */}
          <View
            pointerEvents="none"
            className={
              active
                ? "absolute inset-0 border-accent"
                : tab.private
                  ? "absolute inset-0 border-white/10"
                  : "absolute inset-0 border-black/10 dark:border-white/10"
            }
            style={{ borderRadius: radius.tile, borderWidth: active ? 2.5 : StyleSheet.hairlineWidth }}
          />
        </Pressable>
        <Pressable
          testID={`tab-close-${index}`}
          accessibilityRole="button"
          accessibilityLabel={t("tabs.closeLabel", { title })}
          hitSlop={8}
          onPress={close}
          className="absolute items-center justify-center rounded-full bg-black/45"
          style={{ top: 6, right: 6, width: 22, height: 22 }}
        >
          <Icon name="close" color="#FFFFFF" size={12} />
        </Pressable>
        {tab.private ? (
          <View
            testID={`tab-private-${index}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute items-center justify-center rounded-full bg-neutral-900"
            style={{ top: 6, left: 6, width: 22, height: 22 }}
          >
            <Icon name="private" color="#F4F4F5" size={12} />
          </View>
        ) : null}
      </View>
      {/* The card says all of this, so readers go from the card to its close button. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="flex-row items-center" style={{ gap: 4 }}>
        {tab.url && !hidden ? <SiteIcon url={tab.url} size={14} /> : null}
        <Text numberOfLines={1} variant="caption" tone="muted" className="flex-1">
          {site}
        </Text>
      </View>
    </View>
  );
}
