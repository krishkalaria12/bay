import { defaultBrowser, makeDefaultBrowser } from "@bay/mobile-welcome";
import * as LocalAuthentication from "expo-local-authentication";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";

import { done, press, tick } from "@/chrome/haptics";
import { useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { Toggle } from "@/chrome/Toggle";
import { rowHeight, space } from "@/chrome/tokens";
import { useT, type MessageKey } from "@/i18n";
import { useBrowserStore } from "@/store/browser";

import { BackButton, Backdrop, SkipButton } from "./Controls";
import { asksAboutLinks, back, DOTS, forward, MORPH, pageCount, pageOf, skipOpensField, STAGE, stageNeeds, stageScale, type Step } from "./flow";
import { NIGHT, useFirstRunColors } from "./palette";
import { RunContext, useLinks, useRun, useTyping, type Run } from "./run";
import { Stage } from "./Stage";
import { useTilt } from "./useTilt";

/** The stage's top under the bar, its air above the words, and the page's widest column (a tablet). */
const BAR = 48;
const STAGE_TOP = 48;
const STAGE_GAP = 16;
const COLUMN = 440;

/**
 * The first launch, after Yab's (Phone/Sources/Welcome/FirstRun.swift, Apache-2.0), in Bay's colours: full pages on
 * one ground, ‹, the dots and Skip at the top, a big title, one line of words, at most one real setting and one button.
 * One glass object goes through every page and becomes the next page's thing: the name's letters squeeze into the
 * desktop link, that becomes the field, the private field, a tab, and at the end the real search field.
 *
 * `onDone` reveals the browser; `openField` when the person skipped early, so the real field takes over from the glass.
 * Nothing here asks for a permission on its own: the lock asks only once its switch is turned on.
 */
export function FirstRun({ onDone }: { onDone: (openField: boolean) => void }): JSX.Element {
  const t = useT();
  const colors = useFirstRunColors();
  const reduced = useReducedMotion();
  const tilt = useTilt(!reduced);
  const [step, setStep] = useState<Step>("welcome");
  const [privateOn, setPrivateOn] = useState(false);
  const [pokes, setPokes] = useState(0);
  // Asked once, as the welcome comes up: whether Bay may ask to be the default browser.
  const asksLinks = useMemo(() => asksAboutLinks(safely(defaultBrowser)), []);
  const typing = useTyping(step === "field", reduced, t);
  const links = useLinks(step === "links", reduced);
  const fade = useSharedValue(1);
  const finished = useRef(false);

  const go = (next: Step) => {
    setStep(next);

    if (next !== "private") setPrivateOn(false);
  };

  const finish = (openField: boolean) => {
    if (finished.current) return;
    finished.current = true;

    if (openField) go("end");
    // The glass reaches the field's place before the welcome fades off it.
    const after = openField && !reduced ? 420 : 0;
    setTimeout(() => {
      fade.value = withTiming(0, { duration: reduced ? 150 : 300 });
      setTimeout(() => onDone(openField), reduced ? 150 : 300);
    }, after);
  };

  const run: Run = {
    step,
    colors,
    tilt,
    reduced,
    privateOn,
    togglePrivate: () => {
      tick();
      setPrivateOn((on) => !on);
    },
    typed: typing.typed,
    landed: typing.landed,
    lit: typing.lit,
    tapField: () => {
      tick();
      typing.tap();
    },
    linkShown: links.shown,
    linkComing: links.coming,
    linkLanding: links.landing,
    pokes,
    poke: () => {
      tick();
      setPokes((count) => count + 1);
    },
  };

  const actions = {
    forward: async () => {
      if (step === "links") {
        tick();
        const result = await makeDefaultBrowser().catch(() => "unavailable" as const);

        if (result === "default") done();
        finish(false);

        return;
      }

      press();
      const next = forward(step, asksLinks);

      if (next === "finish") finish(false);
      else go(next);
    },
    back: () => {
      const previous = back(step);

      if (!previous) return;
      press();
      go(previous);
    },
    skip: () => {
      press();
      finish(skipOpensField(step));
    },
  };

  const faded = useAnimatedStyle(() => ({ opacity: fade.value }));
  const night = step === "private" && privateOn;

  return (
    <RunContext.Provider value={run}>
      <Animated.View testID="welcome" style={[StyleSheet.absoluteFill, faded]} accessibilityViewIsModal importantForAccessibility="yes">
        <StatusBar style={night ? "light" : "auto"} />
        <Ground night={night} hidden={step === "end"} />
        <Screen asksLinks={asksLinks} actions={actions} />
      </Animated.View>
    </RunContext.Provider>
  );
}

/** The system's answer, or `unknown` if the native side couldn't give one. */
function safely(read: () => ReturnType<typeof defaultBrowser>): ReturnType<typeof defaultBrowser> {
  try {
    return read();
  } catch {
    return "unknown";
  }
}

interface Actions {
  forward: () => Promise<void>;
  back: () => void;
  skip: () => void;
}

function Screen({ asksLinks, actions }: { asksLinks: boolean; actions: Actions }): JSX.Element {
  const { step, reduced } = useRun();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const width = Math.min(window.width, COLUMN);
  const height = Math.max(1, window.height - insets.top - insets.bottom);
  const [bottom, setBottom] = useState(300);

  // The drawing as large as the screen allows, a little above the middle of the room it has.
  const available = height - bottom - STAGE_TOP - STAGE_GAP;
  const k = stageScale(width, available, step);
  const air = Math.max(0, (available - stageNeeds(step) * k) * 0.4);
  const scale = useSharedValue(k);
  const top = useSharedValue(air);

  useEffect(() => {
    scale.value = reduced ? k : withSpring(k, MORPH);
    top.value = reduced ? air : withSpring(air, MORPH);
  }, [k, air, reduced, scale, top]);

  const stage = useAnimatedStyle(() => ({ top: STAGE_TOP + top.value, transform: [{ scale: scale.value }] }));

  return (
    <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom, alignItems: "center" }}>
      <View style={{ width, flex: 1 }}>
        <Animated.View
          style={[{ position: "absolute", left: (width - STAGE.width * k) / 2, width: STAGE.width, height: STAGE.height, transformOrigin: "left top" }, stage]}
        >
          <Stage />
        </Animated.View>
        <Bar asksLinks={asksLinks} actions={actions} />
        <View style={{ flex: 1 }} pointerEvents="none" />
        <View onLayout={(event) => setBottom(event.nativeEvent.layout.height)}>
          <Bottom actions={actions} maxWords={Math.max(120, height * 0.42)} />
        </View>
      </View>
    </View>
  );
}

/** The ground: Bay's paper under the icon's glow, its dots barely there; Bay's night in dark mode; night once private. */
function Ground({ night, hidden }: { night: boolean; hidden: boolean }): JSX.Element {
  const { colors, reduced } = useRun();
  const window = useWindowDimensions();
  const dark = useSharedValue(night ? 1 : 0);
  const shown = useSharedValue(hidden ? 0 : 1);

  useEffect(() => {
    dark.value = withTiming(night ? 1 : 0, { duration: reduced ? 0 : 450 });
  }, [night, reduced, dark]);
  useEffect(() => {
    shown.value = withTiming(hidden ? 0 : 1, { duration: 450 });
  }, [hidden, shown]);

  const nightStyle = useAnimatedStyle(() => ({ opacity: dark.value }));
  const groundStyle = useAnimatedStyle(() => ({ opacity: shown.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, groundStyle]} pointerEvents="none">
      <Svg width={window.width} height={window.height}>
        <Defs>
          <LinearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.groundTop} />
            <Stop offset="0.42" stopColor={colors.ground} />
            <Stop offset="1" stopColor={colors.ground} />
          </LinearGradient>
          <RadialGradient id="glow" cx="50%" cy="-8%" rx="130%" ry="62%" fx="50%" fy="-8%">
            <Stop offset="0" stopColor={colors.glow} stopOpacity={0.26} />
            <Stop offset="1" stopColor={colors.glow} stopOpacity={0} />
          </RadialGradient>
          <Pattern id="dots" patternUnits="userSpaceOnUse" width={18} height={18}>
            <Circle cx={9} cy={9} r={1} fill={colors.dot} />
          </Pattern>
        </Defs>
        <Rect x={0} y={0} width={window.width} height={window.height} fill="url(#ground)" />
        <Rect x={0} y={0} width={window.width} height={window.height} fill="url(#glow)" />
        <Rect x={0} y={0} width={window.width} height={window.height} fill="url(#dots)" />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: NIGHT }, nightStyle]} />
    </Animated.View>
  );
}

/** ‹, the dots and Skip. */
function Bar({ asksLinks, actions }: { asksLinks: boolean; actions: Actions }): JSX.Element {
  const { step } = useRun();
  const t = useT();

  return (
    <View
      style={{ height: BAR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.xs }}
    >
      <BackButton testID="welcome-back" label={t("welcome.back")} icon="back" visible={back(step) !== null} onPress={actions.back} />
      <Dots count={pageCount(asksLinks)} page={pageOf(step, asksLinks)} hidden={step === "end"} />
      <SkipButton testID="welcome-skip" label={t("welcome.skip")} visible={step !== "end"} onPress={actions.skip} />
    </View>
  );
}

function Dots({ count, page, hidden }: { count: number; page: number; hidden: boolean }): JSX.Element {
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: space.xs,
        height: BAR - space.xs,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: hidden ? 0 : 1,
      }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, i) => (
        <Dot key={i} on={i === page} />
      ))}
    </View>
  );
}

function Dot({ on }: { on: boolean }): JSX.Element {
  const { colors, reduced } = useRun();
  const lit = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    lit.value = reduced ? (on ? 1 : 0) : withSpring(on ? 1 : 0, DOTS);
  }, [on, reduced, lit]);

  const style = useAnimatedStyle(() => ({ width: 7 + 15 * lit.value }));

  return <Animated.View style={[{ height: 7, borderRadius: 3.5, backgroundColor: on ? colors.ink : colors.faint }, style]} />;
}

/** Each page's title and words, its one setting, and its button. */
function Bottom({ actions, maxWords }: { actions: Actions; maxWords: number }): JSX.Element {
  const { step, colors } = useRun();
  const t = useT();
  const words = WORDS[step];

  return (
    <View style={{ paddingHorizontal: space.section, paddingBottom: space.sm, opacity: step === "end" ? 0 : 1 }}>
      <Animated.View
        key={step}
        entering={FadeIn.duration(300).delay(80)}
        exiting={FadeOut.duration(140)}
        style={{ paddingHorizontal: 6, gap: space.sm + 2, maxHeight: maxWords }}
      >
        {words ? (
          <>
            <Text testID="welcome-title" variant="display" color={colors.ink} accessibilityRole="header">
              {t(words.title)}
            </Text>
            <Text testID="welcome-words" color={colors.words}>
              {t(platformWords(words.words))}
            </Text>
          </>
        ) : null}
      </Animated.View>
      <Animated.View key={`setting-${step}`} entering={FadeIn.duration(240).delay(100)} exiting={FadeOut.duration(120)}>
        <SettingRow />
      </Animated.View>
      <CallButton onPress={() => void actions.forward()} />
    </View>
  );
}

const WORDS: Record<Step, { title: MessageKey; words: MessageKey } | null> = {
  welcome: { title: "welcome.title.welcome", words: "welcome.words.welcome" },
  desktop: { title: "welcome.title.desktop", words: "welcome.words.desktop" },
  field: { title: "welcome.title.field", words: "welcome.words.field" },
  private: { title: "welcome.title.private", words: "welcome.words.private" },
  links: { title: "welcome.title.links", words: "welcome.words.links" },
  end: null,
};

/** The links page says where links come from in each phone's own words. */
function platformWords(key: MessageKey): MessageKey {
  return key === "welcome.words.links" && Platform.OS === "android" ? "welcome.words.links.android" : key;
}

/** The page's one setting, on a plate: the field page's keyboard, the private page's lock. */
function SettingRow(): JSX.Element | null {
  const { step, colors } = useRun();
  const t = useT();
  const preferences = useBrowserStore((state) => state.data.preferences);
  const dispatch = useBrowserStore((state) => state.dispatch);

  if (step !== "field" && step !== "private") return null;
  const keyboard = step === "field";
  const value = keyboard ? preferences.searchOnLaunch : preferences.lockPrivateTabs;
  const label = t(keyboard ? "settings.searchOnLaunch" : "settings.lockPrivate");
  const detail = t(keyboard ? "settings.searchOnLaunch.detail" : "settings.lockPrivate.detail");

  const change = async () => {
    tick();

    if (keyboard) {
      dispatch({ type: "preferences", update: { searchOnLaunch: !value } });

      return;
    }

    // Turning the lock on proves Face ID, Touch ID or the passcode works before relying on it.
    if (!value) {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: t("lock.prompt") });

      if (!result.success) return;
    }

    dispatch({ type: "lock-private-tabs", enabled: !value });
  };

  return (
    <Pressable
      testID={keyboard ? "welcome-keyboard" : "welcome-lock"}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked: value }}
      onPress={() => void change()}
      style={{
        marginTop: 22,
        minHeight: 64,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingLeft: space.section,
        paddingRight: space.lg,
        paddingVertical: space.sm + 2,
      }}
    >
      <Backdrop radius={30} tone="clear" />
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text weight="medium" color={colors.ink}>
          {label}
        </Text>
        <Text variant="footnote" color={colors.words}>
          {detail}
        </Text>
      </View>
      <Toggle value={value} />
    </Pressable>
  );
}

/** The page's one button, in ink. */
function CallButton({ onPress }: { onPress: () => void }): JSX.Element {
  const { step, colors } = useRun();
  const t = useT();
  const label = t(step === "welcome" ? "welcome.start" : step === "links" ? "welcome.makeDefault" : "welcome.continue");

  return (
    <PressFeedback
      testID={step === "welcome" ? "welcome-start" : step === "links" ? "welcome-make-default" : "welcome-next"}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={step === "end"}
      onPress={onPress}
      style={{
        marginTop: space.lg,
        height: rowHeight + 4,
        borderRadius: (rowHeight + 4) / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.button,
        shadowColor: "#000000",
        shadowOpacity: 0.18,
        shadowRadius: 11,
        shadowOffset: { width: 0, height: 8 },
      }}
    >
      <Animated.View key={label} entering={FadeIn.duration(200)}>
        <Text variant="headline" color={colors.buttonText}>
          {label}
        </Text>
      </Animated.View>
    </PressFeedback>
  );
}
