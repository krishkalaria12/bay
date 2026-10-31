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
}

const GAP = 14;

/** Lens's switcher: page cards side by side over the wallpaper, each under its site and title. */
export function TabSwitcher({ tabs, activeTabId, onSelect, onClose }: TabSwitcherProps): JSX.Element {
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
          return (
            <View key={tab.id} style={{ width: cardWidth }}>
              <View className="mb-2 flex-row items-center gap-2 pl-1">
                {tab.url ? <SiteIcon url={tab.url} size={18} /> : null}
                <Text numberOfLines={1} className="flex-1" style={{ color: foreground, fontSize: 13, fontWeight: "500" }}>
                  {title}
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
                className="overflow-hidden rounded-[22px] border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900"
                style={{ height: cardHeight, borderWidth: tab.id === activeTabId ? 2 : 1 }}
              >
                {tab.snapshot ? (
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
