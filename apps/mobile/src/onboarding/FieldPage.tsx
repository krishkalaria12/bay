import { useEffect, type JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInUp, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import { Backdrop } from "./Controls";
import { useRun } from "./run";

/** The field's glyph column and its inset: the ways use the same, so glyphs and words stand in one line down. */
const GLYPH = 24;
const INSET = 18;
const ROW = 64;
const WIDTH = 362;

/** The field types a phrase; the phrase lands whole in its way. A tap types the next one at once. */
export function TypingField(): JSX.Element {
  const { typed, colors, tapField } = useRun();
  const t = useT();

  return (
    <Pressable
      testID="welcome-demo-field"
      accessibilityRole="button"
      accessibilityLabel={t("search.placeholder")}
      onPress={tapField}
      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: INSET, paddingRight: INSET }}
    >
      <View style={{ width: GLYPH, alignItems: "center" }}>
        <Icon name="search" color={colors.faint} size={iconSize.control} />
      </View>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 1 }}>
        {typed ? (
          <Text variant="headline" weight="regular" color={colors.ink} numberOfLines={1}>
            {typed}
          </Text>
        ) : (
          <Text variant="headline" weight="regular" color={colors.faint} numberOfLines={1}>
            {t("search.placeholder")}
          </Text>
        )}
        <Caret color={colors.accent} />
      </View>
      <Icon name="private" color={colors.ink} size={iconSize.row} />
    </Pressable>
  );
}

function Caret({ color }: { color: string }): JSX.Element {
  const { reduced } = useRun();
  const on = useSharedValue(1);

  useEffect(() => {
    if (reduced) return;
    on.value = withRepeat(
      withSequence(withTiming(1, { duration: 530 }), withTiming(0, { duration: 0 }), withTiming(0, { duration: 530 }), withTiming(1, { duration: 0 })),
      -1,
    );
  }, [reduced, on]);

  const blink = useAnimatedStyle(() => ({ opacity: on.value }));

  return <Animated.View style={[{ width: 2, height: 24, borderRadius: 1, backgroundColor: color }, blink]} />;
}

/** Search, Go to site, Your tabs: one card of three rows, each a quiet glyph and its name, with the last phrase it took. */
export function FieldWays(): JSX.Element {
  const { landed, lit, colors } = useRun();
  const t = useT();

  const ways: { label: string; icon: IconName }[] = [
    { label: t("welcome.way.search"), icon: "search" },
    { label: t("welcome.way.go"), icon: "link" },
    { label: t("welcome.way.tabs"), icon: "tabs" },
  ];

  return (
    <View style={{ width: WIDTH, borderRadius: radius.panel, overflow: "hidden" }} accessible accessibilityLabel={ways.map((way) => way.label).join(", ")}>
      <Backdrop radius={radius.panel} tone="clear" />
      {ways.map((way, i) => (
        <View key={way.label}>
          {i > 0 ? <View style={{ height: StyleSheet.hairlineWidth, marginLeft: INSET + GLYPH + space.md, backgroundColor: colors.hairline }} /> : null}
          <View style={{ height: ROW, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: INSET, paddingRight: INSET }}>
            {lit === i ? (
              <Animated.View
                entering={FadeIn.duration(120)}
                exiting={FadeOut.duration(300)}
                style={[StyleSheet.absoluteFill, { backgroundColor: colors.accent, opacity: 0.1 }]}
              />
            ) : null}
            <View style={{ width: GLYPH, alignItems: "center" }}>
              <Icon name={way.icon} color={colors.words} size={iconSize.row} />
            </View>
            <View style={{ flex: 1 }}>
              {landed[i] ? (
                <>
                  <Text variant="footnote" weight="semibold" color={colors.faint}>
                    {way.label}
                  </Text>
                  <Animated.View key={landed[i]} entering={FadeInUp.duration(320)}>
                    <Text variant="headline" weight="regular" color={colors.ink} numberOfLines={1}>
                      {landed[i]}
                    </Text>
                  </Animated.View>
                </>
              ) : (
                <Text variant="headline" weight="regular" color={colors.ink}>
                  {way.label}
                </Text>
              )}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
