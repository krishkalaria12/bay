import { View } from "@bay/platform";
import { Surface, VisualEffect, WindowDragRegion } from "@bay/shell";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "@bay/platform/motion";
import { tensionSpring } from "../../lib/springs";
import { hex } from "../../lib/theme";
import { useWindowId } from "../../store/hooks";
import { Intro } from "./Intro";
import { dismissOnboarding, FIRST_STEP, goToStep, useOnboarding } from "./state";
import { DefaultBrowserStep, OutroStep, PersonalizeStep, PinnedTabsStep } from "./steps";
import { ImportStep } from "./importStep";
import { PrivacyStep } from "./privacyStep";
import { SearchStep } from "./searchStep";
import { ToolTour } from "./tour/ToolTour";
import { useOnboardingColors } from "./ui";
import { ONBOARDING_CARD } from "./constants";

export function OnboardingOverlay() {
  const windowId = useWindowId();
  const active = useOnboarding((s) => s.windowId === windowId);
  const session = useOnboarding((s) => s.session);
  return (
    <>
      {active ? <Overlay key={session} session={session} /> : null}
      <ToolTour />
    </>
  );
}

function Overlay({ session }: { session: number }) {
  const colors = useOnboardingColors();
  const step = useOnboarding((s) => s.step);
  const leaving = useOnboarding((s) => s.leaving);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const presence = useSharedValue(0);
  const card = useSharedValue(0);

  useEffect(() => {
    presence.set(withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) }));
  }, []);

  useEffect(() => {
    if (step === "intro") return card.set(0);
    card.set(withSpring(1, tensionSpring(60, 9)));
  }, [step === "intro"]);

  useEffect(() => {
    if (!leaving) return;
    const dismiss = () => dismissOnboarding(session);
    card.set(withTiming(2, { duration: 420, easing: Easing.in(Easing.cubic) }));
    presence.set(
      withTiming(0, { duration: 420, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(dismiss)();
      }),
    );
  }, [leaving]);
  const presenceStyle = useAnimatedStyle(() => ({ opacity: presence.get() }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: interpolate(card.get(), [0, 1, 2], [0, 1, 0]),
    transform: [{ translateY: interpolate(card.get(), [0, 1, 2], [24, 0, 0]) }, { scale: interpolate(card.get(), [0, 1, 2], [0.97, 1, 1.03]) }],
  }));

  const width = Math.min(ONBOARDING_CARD.width, Math.max(0, size.width - ONBOARDING_CARD.margin * 2));
  const height = Math.min(ONBOARDING_CARD.height, Math.max(0, size.height - ONBOARDING_CARD.margin * 2));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, presenceStyle]}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      <VisualEffect material="fullScreenUI" blendingMode="withinWindow" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} />
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      {step !== "intro" && width > 0 && (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="box-none">
          <Animated.View style={[{ width, height }, cardStyle]}>
            <Surface
              fill={hex(colors.card)}
              cornerRadius={20}
              borderColor={hex(colors.cardBorder)}
              borderWidth={0.5}
              shadowColor="#000000"
              shadowOpacity={0.28}
              shadowRadius={40}
              shadowOffset={[0, 18]}
              style={{ flex: 1, overflow: "hidden" }}
            >
              <View key={step} style={{ flex: 1 }}>
                {step === "import" && <ImportStep />}
                {step === "personalize" && <PersonalizeStep />}
                {step === "search" && <SearchStep />}
                {step === "pinnedTabs" && <PinnedTabsStep />}
                {step === "privacy" && <PrivacyStep />}
                {step === "defaultBrowser" && <DefaultBrowserStep />}
                {step === "outro" && <OutroStep />}
              </View>
            </Surface>
          </Animated.View>
        </View>
      )}
      {step === "intro" && <Intro onDone={() => goToStep(FIRST_STEP)} />}
    </Animated.View>
  );
}
