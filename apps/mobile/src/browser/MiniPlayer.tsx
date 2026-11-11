import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { useT } from "@/i18n";

export interface MiniPlayerProps {
  title: string;
  site: string;
  playing: boolean;
  /** The media is a video: picture in picture exists to be asked for. */
  video: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onPictureInPicture: () => void;
  onClose: () => void;
}

/** Media playing in a tab that isn't on screen: tap to go back to it, play or pause it, skip ten seconds, or stop it. */
export function MiniPlayer({ title, site, playing, video, onOpen, onToggle, onSeek, onPictureInPicture, onClose }: MiniPlayerProps): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();

  return (
    <Surface radius={22} style={{ paddingVertical: 6, paddingLeft: 14, paddingRight: 6 }}>
      <View className="flex-row items-center gap-1">
        <Pressable
          testID="mini-player"
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${playing ? t("player.playing") : t("player.paused")}. ${t("player.goToTab")}`}
          onPress={onOpen}
          className="flex-1 justify-center py-1"
        >
          <Text numberOfLines={1} variant="callout" weight="medium">
            {title}
          </Text>
          <Text numberOfLines={1} variant="footnote" tone="muted">
            {site}
          </Text>
        </Pressable>
        <Pressable
          testID="mini-player-back"
          accessibilityRole="button"
          accessibilityLabel={t("player.backTen")}
          onPress={() => onSeek(-10)}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="back" color={muted} size={20} />
        </Pressable>
        <Pressable
          testID="mini-player-toggle"
          accessibilityRole="button"
          accessibilityLabel={playing ? t("player.pause") : t("player.play")}
          onPress={onToggle}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name={playing ? "pause" : "play"} color={foreground} size={22} />
        </Pressable>
        <Pressable
          testID="mini-player-forward"
          accessibilityRole="button"
          accessibilityLabel={t("player.forwardTen")}
          onPress={() => onSeek(10)}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="forward" color={muted} size={20} />
        </Pressable>
        {video ? (
          <Pressable
            testID="mini-player-pip"
            accessibilityRole="button"
            accessibilityLabel={t("player.pictureInPicture")}
            onPress={onPictureInPicture}
            className="h-11 w-11 items-center justify-center"
          >
            <Icon name="pip" color={muted} size={20} />
          </Pressable>
        ) : null}
        <Pressable
          testID="mini-player-close"
          accessibilityRole="button"
          accessibilityLabel={t("player.stopAndClose")}
          onPress={onClose}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="close" color={muted} size={20} />
        </Pressable>
      </View>
    </Surface>
  );
}
