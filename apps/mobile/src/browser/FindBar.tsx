import { useThemeColor } from "heroui-native";
import { type JSX } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { Surface } from "@/chrome/Surface";

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
  const position = useAnimatedStyle(() => ({ bottom: Math.max(keyboard.height.value, insets.bottom) + 8 }));
  const matches = Boolean(count);
  const status = !query || count === null ? "" : count === 0 ? "No matches" : `${index + 1} of ${count}`;

  return (
    <Animated.View style={[{ position: "absolute", left: 8 + insets.left, right: 8 + insets.right }, position]} testID="find-bar">
      <Surface radius={24} style={{ padding: 8 }}>
        <View className="flex-row items-center gap-1">
          <View className="h-11 flex-1 flex-row items-center rounded-full border border-black/10 bg-white/60 pl-4 pr-3 dark:border-white/10 dark:bg-white/10">
            <TextInput
              testID="find-input"
              accessibilityLabel="Find on page"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              placeholder="Find on page"
              placeholderTextColor={muted}
              style={{ flex: 1, fontSize: 16, color: foreground, height: 44 }}
              value={query}
              onChangeText={onChange}
              onSubmitEditing={() => onStep(1)}
              blurOnSubmit={false}
            />
            <Text testID="find-count" style={{ color: muted, fontSize: 13 }}>
              {status}
            </Text>
          </View>
          <FindButton id="find-previous" icon="up" label="Previous match" disabled={!matches} color={foreground} onPress={() => onStep(-1)} />
          <FindButton id="find-next" icon="down" label="Next match" disabled={!matches} color={foreground} onPress={() => onStep(1)} />
          <Pressable
            testID="find-done"
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onDone}
            className="h-11 items-center justify-center rounded-full px-3"
          >
            <Text style={{ color: foreground, fontSize: 15, fontWeight: "600" }}>Done</Text>
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
