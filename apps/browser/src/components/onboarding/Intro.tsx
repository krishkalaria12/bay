import { Pressable, View } from "@bay/platform";
import { DIA_SPECTRUM, PowerUp } from "@bay/shaders";
import { playIntroMusic, setIntroMusicMuted, stopIntroMusic, Symbol } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "@bay/platform/motion";
import { useTheme } from "../../lib/theme";
import { useHover } from "../primitives";
import { introMusicMuted, saveIntroMusicMuted } from "./state";
import { SecondaryButton, useOnboardingColors } from "./ui";
import { APP_NAME } from "../../lib/constants";
import { APP_ICON } from "../../lib/assets";
import { INTRO_CUES, INTRO_EXIT, INTRO_ICON_SPRING, INTRO_LETTER, INTRO_TAGLINE } from "./constants";

const ms = (s: number) => Math.round(s * 1000);
const EASE = Easing.out(Easing.cubic);

export function Intro({ onDone }: { onDone: () => void }) {
  const colors = useOnboardingColors();
  const dark = useTheme().dark;
  const icon = useSharedValue(0);
  const tagline = useSharedValue(0);
  const exit = useSharedValue(0);
  const done = useRef(false);
  const [muted, setMuted] = useState(introMusicMuted);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  useEffect(() => {
    icon.set(withDelay(ms(INTRO_CUES.icon), withSpring(1, INTRO_ICON_SPRING)));
    tagline.set(withDelay(ms(INTRO_CUES.tagline), withTiming(1, { duration: ms(INTRO_TAGLINE), easing: EASE })));
    // The exit comes last: the intro ends with it.
    exit.set(
      withDelay(
        ms(INTRO_CUES.exit),
        withTiming(1, { duration: ms(INTRO_EXIT), easing: Easing.inOut(Easing.cubic) }, (finished) => {
          if (finished) runOnJS(finish)();
        }),
      ),
    );
    playIntroMusic(INTRO_CUES, introMusicMuted());
    return () => {
      cancelAnimation(icon);
      cancelAnimation(tagline);
      cancelAnimation(exit);
    };
  }, []);

  const skip = () => {
    stopIntroMusic(0.35);
    exit.set(
      withTiming(1, { duration: 280, easing: Easing.out(Easing.quad) }, () => {
        runOnJS(finish)();
      }),
    );
  };
  const screen = useAnimatedStyle(() => ({ opacity: interpolate(exit.get(), [0, 0.6, 1], [1, 1, 0]) }));
  const zoom = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(exit.get(), [0, 1], [1, 1.08]) }] }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(icon.get(), [0, 0.4, 1], [0, 1, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(icon.get(), [0, 1], [0.6, 1]) }],
  }));
  const taglineStyle = useAnimatedStyle(() => ({ opacity: tagline.get(), transform: [{ translateY: interpolate(tagline.get(), [0, 1], [6, 0]) }] }));

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setIntroMusicMuted(next);
    saveIntroMusicMuted(next);
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }, screen]}>
      <PowerUp palette={DIA_SPECTRUM} speed={0.8} origin={0.5} style={[StyleSheet.absoluteFill, { opacity: dark ? 0.9 : 0.6 }]} />
      <Animated.View style={[{ alignItems: "center", gap: 18 }, zoom]}>
        <Animated.View style={iconStyle}>
          <Image source={APP_ICON} style={{ width: 96, height: 96 }} />
        </Animated.View>
        <View style={{ flexDirection: "row" }} accessibilityLabel={APP_NAME}>
          {[...APP_NAME].map((ch, i) => (
            <Letter key={i} letter={ch} index={i} color={colors.title} />
          ))}
        </View>
        <Animated.View style={taglineStyle}>
          <Text style={{ fontSize: 17, fontWeight: "300", color: colors.subtitle }}>Your new home on the internet</Text>
        </Animated.View>
      </Animated.View>
      <View style={{ position: "absolute", left: 28, bottom: 28 }}>
        <MuteButton muted={muted} onPress={toggleMute} />
      </View>
      <View style={{ position: "absolute", right: 28, bottom: 28 }} accessibilityHint="Button that skips the onboarding intro animation">
        <SecondaryButton title="Skip" onPress={skip} />
      </View>
    </Animated.View>
  );
}

// A letter of the wordmark, rising in on its cue.
function Letter({ letter, index, color }: { letter: string; index: number; color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withDelay(ms(INTRO_CUES.letters + index * INTRO_CUES.letterStep), withTiming(1, { duration: ms(INTRO_LETTER), easing: EASE })));
    return () => cancelAnimation(t);
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: t.get(), transform: [{ translateY: interpolate(t.get(), [0, 1], [14, 0]) }] }));
  return <Animated.Text style={[{ fontSize: 64, fontWeight: "200", letterSpacing: -1.5, color }, style]}>{letter}</Animated.Text>;
}

function MuteButton({ muted, onPress }: { muted: boolean; onPress: () => void }) {
  const colors = useOnboardingColors();
  const { hovered, hoverProps } = useHover();
  const label = muted ? "Unmute intro music" : "Mute intro music";
  return (
    <View {...hoverProps} tooltip={label}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {({ pressed }) => (
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered ? colors.outlinedHover : "transparent",
              borderWidth: 1,
              borderColor: colors.noThanksBorder,
              transform: [{ scale: pressed ? 0.96 : 1 }],
            }}
          >
            <Symbol
              name={muted ? "speaker.slash.fill" : "speaker.wave.3.fill"}
              size={13}
              weight="medium"
              color={colors.noThanksText}
              style={{ width: 20, height: 20 }}
            />
          </View>
        )}
      </Pressable>
    </View>
  );
}
