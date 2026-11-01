import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Image, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";

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

const GAP = 14;

/** Lens's switcher: page cards side by side over the wallpaper, each under its site and title. */
export function TabSwitcher({ tabs, activeTabId, onSelect, onClose, onCloseAll, privateLocked }: TabSwitcherProps): JSX.Element {
  const { width, height } = useWindowDimensions();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const cardWidth = Math.round(width * 0.66);
  const cardHeight = Math.round(Math.min(height * 0.6, cardWidth * 2.05));
  const inset = (width - cardWidth) / 2;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );

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
      <ScrollView
        horizontal
        style={{ flexGrow: 0 }}
        contentOffset={{ x: activeIndex * (cardWidth + GAP), y: 0 }}
        showsHorizontalScrollIndicator={false}
        snapToInterval={cardWidth + GAP}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: inset, gap: GAP }}
      >
        {tabs.map((tab, index) => {
          const title = tab.title || (tab.url ? displayUrl(tab.url) : "New tab");
          const hidden = Boolean(tab.private && privateLocked);
          return (
            <View key={tab.id} style={{ width: cardWidth }}>
              <View className="mb-2 flex-row items-center gap-2 pl-1">
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
                  onPress={() => onClose(tab.id)}
                  className="h-8 w-8 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
                >
                  <Icon name="close" color={muted} size={16} />
                </Pressable>
              </View>
              <Pressable
                testID={`tab-card-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${title}`}
                accessibilityState={{ selected: tab.id === activeTabId }}
                onPress={() => onSelect(tab.id)}
                className={
                  tab.private
                    ? "overflow-hidden rounded-[22px] border border-white/10 bg-neutral-900"
                    : "overflow-hidden rounded-[22px] border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900"
                }
                style={{ height: cardHeight, borderWidth: tab.id === activeTabId ? 2 : 1 }}
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
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
