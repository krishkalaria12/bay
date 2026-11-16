import { BlurMask, Canvas, Circle, Fill, ImageShader, Shader, makeImageFromView, type SkImage } from "@shopify/react-native-skia";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState, type ComponentRef, type JSX, type RefObject } from "react";
import { Image, StyleSheet, findNodeHandle, View, useColorScheme, useWindowDimensions } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useDerivedValue, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import Svg, { Circle as Dot, Defs, Pattern, Rect } from "react-native-svg";

import { Icon } from "@/chrome/Icon";
import { useReducedMotion } from "@/chrome/motion";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { lensEffect } from "./lens";

/** Paper and ink: warm in the light, Bay's night in the dark. */
const PAPER = {
  light: { paper: "#F4F0E8", ink: "#1C1B19", muted: "rgba(28,27,25,0.56)", dot: "rgba(28,27,25,0.07)" },
  dark: { paper: "#121216", ink: "#F3F2EF", muted: "rgba(243,242,239,0.56)", dot: "rgba(243,242,239,0.06)" },
};

/** How much the resting dome and the lifted lens magnify the page beneath. */
const DOME_ZOOM = 1.45;
const LENS_ZOOM = 1.65;
/** How far up the lens has to be carried (as a share of the screen) before letting go opens it. */

const OPEN_AT = 0.38;

const smooth = (value: number) => {
  "worklet";
  const clamped = Math.min(Math.max(value, 0), 1);

  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * The welcome a new install opens on: a sheet of paper saying what Bay is, with a glass dome resting on its bottom
 * edge. Through the dome is Bay itself (the start page underneath the welcome), magnified like a page under thick
 * glass. Swipe the dome up and it becomes a lens carried over the paper; let go high enough (or tap it) and the lens
 * opens out past the corners into Bay. Let go early and it drops back into its dome.
 */
export function Welcome({ behind, onDone }: { behind: RefObject<ComponentRef<typeof View> | null>; onDone: () => void }): JSX.Element {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const colors = PAPER[scheme];
  const reduced = useReducedMotion();
  const [page, setPage] = useState<SkImage | null>(null);

  // The dome rests mostly below the screen; lifted, it's a smaller lens.
  const domeRadius = width * 0.46;
  const lensRadius = width * 0.34;
  const restX = width / 2;
  // Tall enough above the bottom edge that a thumb picks it up clear of the system's home gesture.
  const restY = height + domeRadius * 0.12;
  const domeTop = restY - domeRadius;

  const centreX = useSharedValue(restX);
  const centreY = useSharedValue(restY);
  const radius = useSharedValue(domeRadius);
  const zoom = useSharedValue(DOME_ZOOM);
  const open = useSharedValue(0);
  const lift = useSharedValue(0);
  const carrying = useSharedValue(false);
  const opening = useSharedValue(false);

  // A picture of Bay underneath, for the glass to show. Taken once it has drawn, and again as the lens is picked up.
  const snapshot = useCallback(() => {
    // Skia finds the view by its native tag.
    const tag = behind.current ? findNodeHandle(behind.current) : undefined;

    if (tag === undefined || tag === null) return;

    makeImageFromView({ current: tag })
      .then((image) => {
        if (image) setPage(image);
      })
      .catch(() => {});
  }, [behind]);

  useEffect(() => {
    const timer = setTimeout(snapshot, 450);

    return () => clearTimeout(timer);
  }, [snapshot, scheme]);

  const celebrate = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  const openLens = () => {
    "worklet";
    const duration = reduced ? 380 : 760;
    const easing = Easing.out(Easing.cubic);

    opening.value = true;
    scheduleOnRN(celebrate);
    zoom.value = withTiming(1, { duration, easing });
    open.value = withTiming(1, { duration, easing });
    radius.value = withTiming(Math.hypot(width, height) * 1.05, { duration, easing }, (done) => {
      if (done) scheduleOnRN(onDone);
    });
  };

  const dropBack = () => {
    "worklet";
    const spring = { damping: 18, stiffness: 160 };

    centreX.value = withSpring(restX, spring);
    centreY.value = withSpring(restY, spring);
    radius.value = withSpring(domeRadius, spring);
    zoom.value = withSpring(DOME_ZOOM, spring);
    lift.value = withTiming(0);
  };

  const pan = usePanGesture({
    minDistance: 6,
    onBegin: (event) => {
      "worklet";
      // Only the dome can be picked up.
      carrying.value = !opening.value && Math.hypot(event.x - centreX.value, event.y - centreY.value) <= radius.value;

      if (carrying.value) scheduleOnRN(snapshot);
    },
    onUpdate: (event) => {
      "worklet";

      if (!carrying.value) return;

      const lifted = smooth(-event.translationY / (height * OPEN_AT));

      lift.value = lifted;
      centreX.value = restX + event.translationX;
      centreY.value = restY + event.translationY;
      radius.value = domeRadius + (lensRadius - domeRadius) * smooth(lifted * 1.6);
      zoom.value = DOME_ZOOM + (LENS_ZOOM - DOME_ZOOM) * lifted;
    },
    onDeactivate: (event) => {
      "worklet";

      if (!carrying.value) return;

      carrying.value = false;

      if (!event.canceled && (lift.value >= 0.999 || event.velocityY < -900)) openLens();
      else dropBack();
    },
  });

  // A tap on the dome opens it as well.
  const tap = useTapGesture({
    onActivate: (event) => {
      "worklet";

      if (!opening.value && Math.hypot(event.x - centreX.value, event.y - centreY.value) <= radius.value) openLens();
    },
  });

  const gestures = useCompetingGestures(pan, tap);

  const uniforms = useDerivedValue(() => ({
    centre: [centreX.value, centreY.value],
    radius: radius.value,
    zoom: zoom.value,
    open: open.value,
    // The resting dome looks up at Bay's bar, so the bar sits whole inside it; carried, the lens looks straight down.
    shift: [0, -domeRadius * 0.24 * (1 - lift.value) * (1 - open.value)],
  }));

  const shadowY = useDerivedValue(() => centreY.value + radius.value * 0.05);
  const glassOpacity = useDerivedValue(() => 1 - open.value);
  const shadowBlur = useDerivedValue(() => radius.value * 0.09);

  // "Swipe up to start", bobbing gently until the dome is picked up.
  const bob = useSharedValue(0);

  useEffect(() => {
    if (reduced) return;

    const ease = Easing.inOut(Easing.sin);

    bob.value = withRepeat(withSequence(withTiming(-5, { duration: 900, easing: ease }), withTiming(0, { duration: 900, easing: ease })), -1);
  }, [bob, reduced]);

  const hintStyle = useAnimatedStyle(() => ({ opacity: 1 - smooth(lift.value * 3) - open.value, transform: [{ translateY: bob.value }] }));
  // The paper goes as the lens opens, so what's left is Bay itself.
  const paperStyle = useAnimatedStyle(() => ({ opacity: 1 - open.value }));

  return (
    <View testID="welcome" style={StyleSheet.absoluteFill}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, paperStyle]}>
            <Paper color={colors.paper} dot={colors.dot} />
            <View style={{ paddingTop: insets.top + space.lg, paddingHorizontal: space.xl }}>
              <View className="flex-row items-center" style={{ gap: space.sm }}>
                <Image source={require("../../assets/images/bay-mark.png")} style={{ width: 30, height: 30 }} accessibilityIgnoresInvertColors />
                <Text variant="headline" color={colors.ink}>
                  Bay
                </Text>
              </View>
              <Text accessibilityRole="header" variant="display" weight="semibold" color={colors.ink} style={{ marginTop: space.xxl, maxWidth: 360 }}>
                {t("welcome.title")}
              </Text>
              <Text variant="body" color={colors.muted} style={{ marginTop: space.md, maxWidth: 330 }}>
                {t("welcome.body")}
              </Text>
            </View>
            <Animated.View
              pointerEvents="none"
              className="absolute left-0 right-0 items-center"
              style={[{ top: domeTop - space.xl - 34, gap: space.xxs }, hintStyle]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Icon name="up" color={colors.ink} size={iconSize.small} />
              <Text variant="footnote" weight="semibold" color={colors.ink}>
                {t("welcome.swipe")}
              </Text>
            </Animated.View>
          </Animated.View>

          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Circle cx={centreX} cy={shadowY} r={radius} color="rgba(20,16,10,0.22)" opacity={glassOpacity}>
              <BlurMask blur={shadowBlur} style="normal" />
            </Circle>
            {page ? (
              <Fill>
                <Shader source={lensEffect} uniforms={uniforms}>
                  <ImageShader image={page} fit="fill" tx="clamp" ty="clamp" rect={{ x: 0, y: 0, width, height }} />
                </Shader>
              </Fill>
            ) : (
              <Circle cx={centreX} cy={centreY} r={radius} color="rgba(255,255,255,0.35)" />
            )}
            <Circle cx={centreX} cy={centreY} r={radius} style="stroke" strokeWidth={1.2} color="rgba(255,255,255,0.7)" opacity={glassOpacity} />
          </Canvas>

          {/* The dome for screen readers (and tests): touches pass through to the gestures above. */}
          <View
            testID="welcome-start"
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("welcome.start")}
            accessibilityActions={[{ name: "activate" }]}
            onAccessibilityAction={() => {
              if (!opening.value) openLens();
            }}
            pointerEvents="none"
            style={{ position: "absolute", left: restX - domeRadius * 0.8, width: domeRadius * 1.6, top: domeTop, bottom: 0 }}
          />
        </View>
      </GestureDetector>
    </View>
  );
}

/** Warm paper under a fine dot grid, like Bay's wallpapers. */
function Paper({ color, dot }: { color: string; dot: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill} accessible={false}>
      <Defs>
        <Pattern id="dots" width={18} height={18} patternUnits="userSpaceOnUse">
          <Dot cx={9} cy={9} r={1.1} fill={dot} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill={color} />
      <Rect width="100%" height="100%" fill="url(#dots)" />
    </Svg>
  );
}
