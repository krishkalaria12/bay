import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect as SvgRect, Stop } from "react-native-svg";

import { Icon } from "@/chrome/Icon";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";
import { SiteIcon } from "@/browser/SiteIcon";
import { useT } from "@/i18n";

import { Backdrop, Name } from "./Controls";
import type { GlassTone } from "./Controls.types";
import { DesktopLink, DesktopPicture } from "./DesktopPage";
import { FieldWays, TypingField } from "./FieldPage";
import { DRIFT_SITES, hero, LETTERS, MORPH, STAGE, type Rect, type Step } from "./flow";
import { LinkPill, LinksBehind, TabCard } from "./LinksPage";
import { PrivateAround, PrivateField } from "./PrivatePage";
import { useRun } from "./run";
import { useParallax } from "./useTilt";

/** A layer of the drawing that moves with the phone's lean (`depth`, see `useParallax`). */
export function Parallax({ depth, style, children }: { depth: number; style?: object; children: ReactNode }): JSX.Element {
  const { tilt } = useRun();
  const moved = useParallax(tilt, depth);

  return <Animated.View style={[style, moved]}>{children}</Animated.View>;
}

/**
 * The drawing above the words, 402 wide in its own units: the glass object in this page's shape with this page's thing
 * in it, and whatever the page has around it. The screen scales it to fit between the bar and the words.
 */
export function Stage(): JSX.Element {
  const { step } = useRun();
  // The name stays a moment after the first page, squeezing into the next page's glass.
  const [nameShown, setNameShown] = useState(true);
  useEffect(() => {
    if (step === "welcome") {
      setNameShown(true);

      return;
    }

    const timer = setTimeout(() => setNameShown(false), 520);

    return () => clearTimeout(timer);
  }, [step]);

  return (
    <View style={{ width: STAGE.width, height: STAGE.height }} pointerEvents="box-none">
      {step === "welcome" ? (
        <Animated.View
          entering={FadeIn.duration(300)}
          exiting={FadeOut.duration(300)}
          style={{ position: "absolute", top: 48 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Parallax depth={-12}>
            <DriftRows />
          </Parallax>
        </Animated.View>
      ) : null}
      {step === "desktop" ? (
        <Animated.View entering={FadeIn.duration(400)} exiting={FadeOut.duration(200)} style={{ position: "absolute", left: 31, top: 90 }}>
          <Parallax depth={-7}>
            <DesktopPicture />
          </Parallax>
        </Animated.View>
      ) : null}
      {step === "field" ? (
        <Animated.View entering={FadeIn.duration(340).delay(120)} exiting={FadeOut.duration(150)} style={{ position: "absolute", left: 20, top: 160 }}>
          <Parallax depth={3}>
            <FieldWays />
          </Parallax>
        </Animated.View>
      ) : null}
      {step === "private" ? (
        <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(150)} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Parallax depth={-6}>
            <PrivateAround />
          </Parallax>
        </Animated.View>
      ) : null}
      {step === "links" ? (
        <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(150)} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Parallax depth={-8}>
            <LinksBehind />
          </Parallax>
        </Animated.View>
      ) : null}
      {nameShown ? <NameLayer /> : null}
      <Hero />
      <LinkComing />
    </View>
  );
}

/** The one glass object, in this page's shape, with this page's thing in it. */
function Hero(): JSX.Element {
  const { step, privateOn, reduced, linkShown } = useRun();
  const target = hero(step);
  const x = useSharedValue(target.x);
  const y = useSharedValue(target.y);
  const width = useSharedValue(target.width);
  const height = useSharedValue(target.height);
  const shown = useSharedValue(step === "welcome" ? 0 : 1);

  useEffect(() => {
    const to = hero(step);
    const move = (value: number) => (reduced ? withTiming(value, { duration: 240 }) : withSpring(value, MORPH));
    x.value = move(to.x);
    y.value = move(to.y);
    width.value = move(to.width);
    height.value = move(to.height);
    // Only the fade waits for the letters to start squeezing; the shape itself moves on the page's spring.
    shown.value = step === "welcome" ? withTiming(0, { duration: 200 }) : withDelay(120, withTiming(1, { duration: 300 }));
  }, [step, reduced, x, y, width, height, shown]);

  const frame = useAnimatedStyle(() => ({ left: x.value, top: y.value, width: width.value, height: height.value, opacity: shown.value }));
  const tone: GlassTone = step === "private" && privateOn ? "night" : step === "links" || step === "end" ? "solid" : "clear";

  return (
    <Animated.View style={[{ position: "absolute" }, frame]} pointerEvents={step === "welcome" ? "none" : "box-none"}>
      <Parallax depth={6} style={StyleSheet.absoluteFill}>
        <Backdrop radius={target.radius} tone={tone} />
        <View style={[StyleSheet.absoluteFill, { borderRadius: target.radius, overflow: "hidden" }]}>
          <Animated.View
            key={step === "links" ? `links-${linkShown}` : step}
            entering={FadeIn.duration(280)}
            exiting={FadeOut.duration(140)}
            style={StyleSheet.absoluteFill}
          >
            <HeroContent step={step} />
          </Animated.View>
        </View>
      </Parallax>
    </Animated.View>
  );
}

function HeroContent({ step }: { step: Step }): JSX.Element | null {
  switch (step) {
    case "welcome":
      return null;
    case "desktop":
      return <DesktopLink />;
    case "field":
      return <TypingField />;
    case "private":
      return <PrivateField />;
    case "links":
      return <TabCard />;
    case "end":
      return <EndField />;
  }
}

/** A link on its way in from another app, over the tab card. */
function LinkComing(): JSX.Element | null {
  const { step, linkComing } = useRun();

  if (step !== "links" || linkComing === null) return null;

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Parallax depth={10} style={StyleSheet.absoluteFill}>
        <LinkPill />
      </Parallax>
    </Animated.View>
  );
}

/** The last page: the glass is the search field, where the real one opens. */
function EndField(): JSX.Element {
  const { colors } = useRun();
  const t = useT();

  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm + 2, paddingLeft: space.md + 2, paddingRight: space.md }}>
      <Icon name="search" color={colors.faint} size={iconSize.small} />
      <Text variant="callout" color={colors.faint} numberOfLines={1} style={{ flex: 1 }}>
        {t("search.placeholder")}
      </Text>
      <Icon name="private" color={colors.ink} size={iconSize.small} />
    </View>
  );
}

/**
 * The name in glass over the sites drifting by. A finger on it: jelly. Get Started: the letters squeeze into the next
 * page's glass and fade while that glass grows out of them.
 */
function NameLayer(): JSX.Element {
  const { step, pokes, poke, reduced } = useRun();
  const t = useT();
  const melt = useSharedValue(0);
  const squishX = useSharedValue(1);
  const squishY = useSharedValue(1);

  useEffect(() => {
    melt.value = step === "welcome" ? withTiming(0, { duration: 200 }) : reduced ? withTiming(1, { duration: 200 }) : withSpring(1, MORPH);
  }, [step, reduced, melt]);

  useEffect(() => {
    if (pokes === 0 || reduced) return;
    const ease = { easing: Easing.inOut(Easing.cubic) };
    squishX.value = withSequence(
      withTiming(1.1, { duration: 100, ...ease }),
      withTiming(0.93, { duration: 130, ...ease }),
      withTiming(1.04, { duration: 130, ...ease }),
      withTiming(0.985, { duration: 120, ...ease }),
      withTiming(1, { duration: 220, ...ease }),
    );
    squishY.value = withSequence(
      withTiming(0.86, { duration: 100, ...ease }),
      withTiming(1.08, { duration: 130, ...ease }),
      withTiming(0.97, { duration: 130, ...ease }),
      withTiming(1.015, { duration: 120, ...ease }),
      withTiming(1, { duration: 220, ...ease }),
    );
  }, [pokes, reduced, squishX, squishY]);

  const into: Rect = hero("desktop");

  const style = useAnimatedStyle(() => {
    const m = melt.value;
    const dx = into.x + into.width / 2 - (LETTERS.x + LETTERS.width / 2);
    const dy = into.y + into.height / 2 - (LETTERS.y + LETTERS.height / 2);

    return {
      opacity: 1 - m,
      transform: [
        { translateX: dx * m },
        { translateY: dy * m },
        { scaleX: (1 + (into.width / LETTERS.width - 1) * m) * squishX.value },
        { scaleY: (1 + (into.height / LETTERS.height - 1) * m) * squishY.value },
      ],
    };
  });

  return (
    <Parallax depth={5} style={{ position: "absolute", left: LETTERS.x, top: LETTERS.y }}>
      <Animated.View style={[{ transformOrigin: "bottom" }, style]}>
        <Pressable testID="welcome-name" accessibilityRole="button" accessibilityLabel={t("welcome.name")} onPress={poke} disabled={step !== "welcome"}>
          <Name text={t("welcome.name.text")} width={LETTERS.width} height={LETTERS.height} />
        </Pressable>
      </Animated.View>
    </Parallax>
  );
}

const TILE = 76;
const TILE_GAP = 18;

/** Sites drifting by in three rows, the middle one the other way; through the glass letters they show bent. */
function DriftRows(): JSX.Element {
  const { colors } = useRun();

  return (
    <View style={{ width: STAGE.width, height: 300, overflow: "hidden", opacity: 0.6 }}>
      <DriftRow first={0} period={26} reverse={false} top={10} />
      <DriftRow first={4} period={31} reverse top={108} />
      <DriftRow first={8} period={22} reverse={false} top={206} />
      {/* The rows fade in and out at the edges, into the ground. */}
      <Svg width={STAGE.width} height={300} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="drift-edges" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={colors.ground} stopOpacity={1} />
            <Stop offset="0.14" stopColor={colors.ground} stopOpacity={0} />
            <Stop offset="0.86" stopColor={colors.ground} stopOpacity={0} />
            <Stop offset="1" stopColor={colors.ground} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <SvgRect x={0} y={0} width={STAGE.width} height={300} fill="url(#drift-edges)" />
      </Svg>
    </View>
  );
}

function DriftRow({ first, period, reverse, top }: { first: number; period: number; reverse: boolean; top: number }): JSX.Element {
  const { colors, reduced } = useRun();
  const span = 9 * (TILE + TILE_GAP);
  const progress = useSharedValue(reverse ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      progress.value = 0.18;

      return;
    }

    progress.value = withRepeat(withTiming(reverse ? 0 : 1, { duration: period * 1000, easing: Easing.linear }), -1, false);
  }, [reduced, reverse, period, progress]);

  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: -progress.value * span }] }));

  return (
    <Animated.View style={[{ position: "absolute", top, flexDirection: "row", gap: TILE_GAP }, moving]}>
      {Array.from({ length: 18 }, (_, k) => {
        const site = DRIFT_SITES[(first + (k % 9)) % DRIFT_SITES.length]!;

        return (
          <View
            key={k}
            style={{
              width: TILE,
              height: TILE,
              borderRadius: 20,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.tile,
              shadowColor: "#141C36",
              shadowOpacity: 0.1,
              shadowRadius: 9,
              shadowOffset: { width: 0, height: 6 },
            }}
          >
            <SiteIcon url={`https://${site}`} size={40} />
          </View>
        );
      })}
    </Animated.View>
  );
}
