import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { Surface } from "@/chrome/Surface";

export interface MiniPlayerProps {
  title: string;
  site: string;
  playing: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onClose: () => void;
}

/** Media playing in a tab that isn't on screen: tap to go back to it, play or pause it, or stop it. */
export function MiniPlayer({ title, site, playing, onOpen, onToggle, onClose }: MiniPlayerProps): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  return (
    <Surface radius={22} style={{ paddingVertical: 6, paddingLeft: 14, paddingRight: 6 }}>
      <View className="flex-row items-center gap-1">
        <Pressable
          testID="mini-player"
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${playing ? "playing" : "paused"}. Go to tab`}
          onPress={onOpen}
          className="flex-1 justify-center py-1"
        >
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 15, fontWeight: "500" }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ color: muted, fontSize: 13 }}>
            {site}
          </Text>
        </Pressable>
        <Pressable
          testID="mini-player-toggle"
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause" : "Play"}
          onPress={onToggle}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name={playing ? "pause" : "play"} color={foreground} size={22} />
        </Pressable>
        <Pressable
          testID="mini-player-close"
          accessibilityRole="button"
          accessibilityLabel="Stop and close"
          onPress={onClose}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="close" color={muted} size={20} />
        </Pressable>
      </View>
    </Surface>
  );
}
