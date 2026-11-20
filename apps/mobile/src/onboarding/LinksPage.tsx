import { useEffect, type JSX } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect as SvgRect, Stop } from "react-native-svg";

import { SiteIcon } from "@/browser/SiteIcon";
import { Icon } from "@/chrome/Icon";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import { Backdrop } from "./Controls";
import { hero, LINK, LINKS, MORPH } from "./flow";
import { GREEN } from "./palette";
import { useRun } from "./run";

const CARD = hero("links");
const PILL = { x: 201 - 95, y: -6, width: 190, height: 40 };

/** The tabs under the one in front: straight, peeking out above it. */
export function LinksBehind(): JSX.Element {
  const { colors } = useRun();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {[0, 1].map((i) => {
        const width = CARD.width * (0.92 - 0.06 * i);

        return (
          <View
            key={i}
            style={{
              position: "absolute",
              left: 201 - width / 2,
              top: CARD.y - 12 - 11 * i,
              width,
              height: CARD.height,
              borderRadius: CARD.radius,
              backgroundColor: colors.tile,
              opacity: 0.55 - 0.15 * i,
              zIndex: -i,
            }}
          />
        );
      })}
    </View>
  );
}

/** A tab: the page's picture and title, its lines, its address on a plate. */
export function TabCard(): JSX.Element {
  const { linkShown } = useRun();
  const t = useT();
  const link = LINKS[linkShown]!;
  const id = `tab-${linkShown}`;

  return (
    <View style={{ flex: 1, backgroundColor: "#FFFFFF" }} accessible accessibilityLabel={`${t(link.title)}, ${link.host}`}>
      <View style={{ height: CARD.height * 0.62, justifyContent: "flex-end" }}>
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              {link.colors.map((color, i) => (
                <Stop key={color} offset={i / (link.colors.length - 1)} stopColor={color} />
              ))}
            </LinearGradient>
          </Defs>
          <SvgRect x={0} y={0} width="100%" height="100%" fill={`url(#${id})`} />
        </Svg>
        <Text variant="title" weight="bold" color="#FFFFFF" style={{ padding: space.lg }}>
          {t(link.title)}
        </Text>
      </View>
      <View style={{ padding: space.lg, gap: 9 }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ height: 9, borderRadius: 4.5, backgroundColor: "#ECEAF1", width: i === 2 ? "50%" : "100%" }} />
        ))}
      </View>
      <View
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 12,
          height: 34,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
        }}
      >
        <Backdrop radius={17} tone="clear" />
        <SiteIcon url={`https://${link.host}`} size={14} bare />
        <Text variant="footnote" color="#1C1B19">
          {link.host}
        </Text>
      </View>
    </View>
  );
}

/** A link on its way in from another app: a pill at the top that grows into the tab in front. */
export function LinkPill(): JSX.Element | null {
  const { linkComing, linkLanding, reduced, colors } = useRun();
  const grown = useSharedValue(0);

  useEffect(() => {
    grown.value = linkLanding ? (reduced ? withTiming(1, { duration: 200 }) : withSpring(1, MORPH)) : withSpring(0, LINK);
  }, [linkLanding, reduced, grown]);

  const frame = useAnimatedStyle(() => {
    const g = grown.value;

    return {
      left: PILL.x + (CARD.x - PILL.x) * g,
      top: PILL.y + (CARD.y - PILL.y) * g,
      width: PILL.width + (CARD.width - PILL.width) * g,
      height: PILL.height + (CARD.height - PILL.height) * g,
    };
  });

  const words = useAnimatedStyle(() => ({ opacity: 1 - grown.value }));

  if (linkComing === null) return null;
  const link = LINKS[linkComing]!;

  return (
    <Animated.View style={[{ position: "absolute" }, frame]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Backdrop radius={linkLanding ? CARD.radius : radius.card - 2} tone="clear" />
      <Animated.View style={[{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: 6, paddingRight: 14 }, words]}>
        <View style={{ width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: GREEN }}>
          <Icon name={link.from === "mail" ? "share" : "link"} color="#FFFFFF" size={iconSize.inline} />
        </View>
        <Text variant="callout" weight="medium" color={colors.ink} numberOfLines={1}>
          {link.host}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
