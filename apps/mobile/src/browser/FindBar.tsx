import { useThemeColor } from "heroui-native";
import { type JSX } from "react";
import { Pressable, TextInput, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { inputFont, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

export interface FindBarProps {
  query: string;
  /** Matches on the page, or null before the first search finishes. */
  count: number | null;
  /** The current match, from 0. */
  index: number;
  onChange: (query: string) => void;
  onStep: (step: 1 | -1) => void;
  onDone: () => void;
}

/** Find on page: sits above the keyboard in place of the bottom bar, like Safari's. */
export function FindBar({ query, count, index, onChange, onStep, onDone }: FindBarProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();
  const position = useAnimatedStyle(() => ({ bottom: Math.max(keyboard.height.value, insets.bottom) + 8 }));
  const matches = Boolean(count);
  const status = !query || count === null ? "" : count === 0 ? t("find.noMatches") : t("find.matchCount", { index: index + 1, count });

  return (
    <Animated.View style={[{ position: "absolute", left: 8 + insets.left, right: 8 + insets.right }, position]} testID="find-bar">
      <Surface radius={radius.card} style={{ padding: space.sm }}>
        <View className="flex-row items-center gap-1">
          <View className="h-11 flex-1 flex-row items-center rounded-full border border-black/10 bg-white/60 pl-4 pr-3 dark:border-white/10 dark:bg-white/10">
            <TextInput
              testID="find-input"
              accessibilityLabel={t("find.placeholder")}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              placeholder={t("find.placeholder")}
              placeholderTextColor={muted}
              style={[inputFont("body"), { flex: 1, color: foreground, height: 44 }]}
              value={query}
              onChangeText={onChange}
              onSubmitEditing={() => onStep(1)}
              blurOnSubmit={false}
            />
            {/* TalkBack reads each new count as it changes; VoiceOver reads it with the field. */}
            <Text testID="find-count" accessibilityLiveRegion="polite" variant="footnote" tone="muted">
              {status}
            </Text>
          </View>
          <FindButton id="find-previous" icon="up" label={t("find.previous")} disabled={!matches} color={foreground} onPress={() => onStep(-1)} />
          <FindButton id="find-next" icon="down" label={t("find.next")} disabled={!matches} color={foreground} onPress={() => onStep(1)} />
          <Pressable
            testID="find-done"
            accessibilityRole="button"
            accessibilityLabel={t("find.done")}
            onPress={onDone}
            className="h-11 items-center justify-center rounded-full px-3"
          >
            <Text variant="callout" weight="semibold">
              {t("find.done")}
            </Text>
          </Pressable>
        </View>
      </Surface>
    </Animated.View>
  );
}

function FindButton({
  id,
  icon,
  label,
  disabled,
  color,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  disabled: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="h-11 w-10 items-center justify-center"
      style={{ opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} color={color} size={22} />
    </Pressable>
  );
}
