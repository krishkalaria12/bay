import { useThemeColor } from "heroui-native";
import { useEffect, type JSX } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

import { announce } from "@/chrome/screenReader";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

/** Where the tip points: the bar's middle (its capsule) or its right-hand button (the page menu). */
export type TipTarget = "capsule" | "more";

/**
 * A first-run tip (U7), after Arc Search's and Cra's: a card above the bar, with a ring (TipRing) round the control it
 * means. It stays until "Got it", or until the control it points at is used.
 */
export function Tip({ title, body, target, onDone }: { title: string; body: string; target: TipTarget; onDone: () => void }): JSX.Element {
  const t = useT();

  useEffect(() => {
    announce(`${title}. ${body}`);
  }, [title, body]);

  return (
    <Animated.View testID={`tip-${target}`} entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(150)}>
      <Surface radius={radius.card} style={{ padding: space.lg, gap: space.xs }}>
        <Text variant="headline" accessibilityRole="header">
          {title}
        </Text>
        <Text variant="subhead" tone="muted">
          {body}
        </Text>
        <PressFeedback
          testID="tip-done"
          accessibilityRole="button"
          accessibilityLabel={t("tip.gotIt")}
          onPress={onDone}
          className="mt-2 self-end rounded-full bg-accent px-4 py-2"
        >
          <Text variant="subhead" weight="semibold" color="#FFFFFF">
            {t("tip.gotIt")}
          </Text>
        </PressFeedback>
      </Surface>
    </Animated.View>
  );
}

/** A ring round the control a tip means, drawn over the bar (U7). */
export function TipRing({ target }: { target: TipTarget }): JSX.Element {
  const { width } = useWindowDimensions();
  const accent = useThemeColor("accent");
  const size = target === "capsule" ? { width: 184, height: 62 } : { width: 62, height: 62 };
  // The bar is centred: its right-hand button sits 122 pt right of the middle (a 172 pt capsule, 12 pt gaps, 49 pt
  // buttons).
  const centreX = target === "capsule" ? width / 2 : width / 2 + 122;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: -6,
        left: centreX - size.width / 2,
        ...size,
        borderRadius: 31,
        borderWidth: 2.5,
        borderColor: accent,
      }}
    />
  );
}
