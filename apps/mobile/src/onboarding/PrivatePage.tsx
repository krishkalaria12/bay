import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { PEN_FACE } from "@/chrome/fonts";
import { Icon } from "@/chrome/Icon";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import { CHIPS, STAGE } from "./flow";
import { useRun } from "./run";

const NIGHT_INK = "rgba(255,255,255,0.88)";

/** The private page's field: tap the glasses and the page goes night. */
export function PrivateField(): JSX.Element {
  const { privateOn, togglePrivate, colors, reduced } = useRun();
  const t = useT();
  const label = useSharedValue(privateOn ? 1 : 0);
  // The word's own width in this language, measured off screen, so it slides out to exactly its size.
  const [wordWidth, setWordWidth] = useState(0);

  useEffect(() => {
    label.value = withTiming(privateOn ? 1 : 0, { duration: reduced ? 0 : 450 });
  }, [privateOn, reduced, label]);

  const reveal = useAnimatedStyle(() => ({ width: label.value * wordWidth, opacity: label.value }));

  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: 18, paddingRight: space.sm + 2 }}>
      <View style={{ width: 24, alignItems: "center" }}>
        <Icon name="search" color={privateOn ? "rgba(255,255,255,0.7)" : colors.faint} size={iconSize.row} />
      </View>
      <Text variant="body" color={privateOn ? "rgba(255,255,255,0.5)" : colors.faint} numberOfLines={1} style={{ flex: 1 }}>
        {t("search.placeholder")}
      </Text>
      <Pressable
        testID="welcome-glasses"
        accessibilityRole="button"
        accessibilityLabel={t(privateOn ? "welcome.private.off" : "welcome.private.onLabel")}
        onPress={togglePrivate}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 44, minHeight: 44, justifyContent: "flex-end" }}
      >
        {/* The word is the button's to say (its label): both copies stay out of the screen reader. */}
        <Animated.View style={[{ overflow: "hidden" }, reveal]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text accessible={false} weight="medium" color={NIGHT_INK} numberOfLines={1} style={{ width: wordWidth || undefined }}>
            {t("welcome.private.label")}
          </Text>
        </Animated.View>
        <View style={{ position: "absolute", opacity: 0 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text accessible={false} weight="medium" onLayout={(event) => setWordWidth(Math.ceil(event.nativeEvent.layout.width))}>
            {t("welcome.private.label")}
          </Text>
        </View>
        <Icon name="private" color={privateOn ? "#FFFFFF" : colors.ink} size={iconSize.control} />
      </Pressable>
    </View>
  );
}

/** Around it: "tap the glasses" in the pen, and once they're on, what private means, in chips. */
export function PrivateAround(): JSX.Element {
  const { privateOn, colors } = useRun();
  const t = useT();

  const chips = [
    [t("welcome.private.chip.device"), t("welcome.private.chip.closed")],
    [t("welcome.private.chip.history"), t("welcome.private.chip.blocked")],
  ];

  return (
    <View
      style={{ width: STAGE.width, height: STAGE.height }}
      accessible={privateOn}
      accessibilityLabel={privateOn ? [t("welcome.private.on"), ...chips.flat()].join(", ") : undefined}
    >
      <Shown on={privateOn} delay={100} style={{ position: "absolute", top: 48, width: STAGE.width, alignItems: "center", gap: space.sm + 2 }}>
        <Icon name="private" color={NIGHT_INK} size={46} />
        <Text variant="headline" weight="medium" color={NIGHT_INK}>
          {t("welcome.private.on")}
        </Text>
      </Shown>
      <View style={{ position: "absolute", top: 238, width: STAGE.width, alignItems: "center", gap: space.sm + 2 }}>
        {chips.map((row, r) => (
          <View key={r} style={{ flexDirection: "row", gap: space.sm }}>
            {row.map((chip, c) => (
              <Chip key={chip} text={chip} index={r * 2 + c} on={privateOn} />
            ))}
          </View>
        ))}
      </View>
      <Shown on={!privateOn} delay={0} style={{ position: "absolute", left: 206, top: 92 }}>
        <Text style={{ fontFamily: PEN_FACE, fontSize: 26, lineHeight: 30, color: colors.accent }}>{t("welcome.private.pen")}</Text>
        <Svg width={40} height={46} style={{ position: "absolute", left: 120, top: 22 }}>
          <Path
            d="M8 2 C18 10 24 20 26 36 M18 30 L26 37 L31 28"
            stroke={colors.accent}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </Shown>
    </View>
  );
}

function Shown({ on, delay, style, children }: { on: boolean; delay: number; style: object; children: ReactNode }): JSX.Element {
  const { reduced } = useRun();
  const shown = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    shown.value = on ? withDelay(reduced ? 0 : delay, withTiming(1, { duration: 350 })) : withTiming(0, { duration: 300 });
  }, [on, delay, reduced, shown]);

  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));

  return <Animated.View style={[style, fade]}>{children}</Animated.View>;
}

function Chip({ text, index, on }: { text: string; index: number; on: boolean }): JSX.Element {
  const { reduced } = useRun();
  const shown = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    if (!on) {
      shown.value = withTiming(0, { duration: 200 });

      return;
    }

    shown.value = reduced ? withTiming(1, { duration: 200 }) : withDelay(120 + index * 70, withSpring(1, CHIPS));
  }, [on, index, reduced, shown]);

  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, shown.value), transform: [{ scale: 0.7 + 0.3 * shown.value }] }));

  return (
    <Animated.View
      style={[
        {
          height: 34,
          paddingHorizontal: 14,
          borderRadius: 17,
          justifyContent: "center",
          backgroundColor: "rgba(255,255,255,0.12)",
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: "rgba(255,255,255,0.22)",
        },
        style,
      ]}
    >
      <Text variant="subhead" weight="semibold" color="#FFFFFF">
        {text}
      </Text>
    </Animated.View>
  );
}
