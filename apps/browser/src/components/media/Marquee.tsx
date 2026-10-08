import { useEffect, useState } from "react";
import { Text, View, type TextStyle } from "react-native";
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from "react-native-reanimated";

const SPEED = 30;
const PAUSE_MS = 1500;
const FADE = 12;
const FADE_STEPS = 8;

export type MarqueeGroup = {
  progress: SharedValue<number>;
  report(key: string, overflow: number): void;
};

export function useMarqueeGroup(resetKey: string): MarqueeGroup {
  const progress = useSharedValue(0);
  const [overflows, setOverflows] = useState<Record<string, number>>({});
  const max = Math.max(0, ...Object.values(overflows));
  useEffect(() => {
    cancelAnimation(progress);
    progress.set(0);
    if (max < 1) return;
    const duration = (max / SPEED) * 1000;
    const leg = (toValue: number) => withDelay(PAUSE_MS, withTiming(toValue, { duration, easing: Easing.linear }));
    progress.set(withRepeat(withSequence(leg(1), leg(0)), -1, false));
    return () => cancelAnimation(progress);
  }, [max, resetKey]);
  return {
    progress,
    report: (key, overflow) => setOverflows((o) => (Math.abs((o[key] ?? 0) - overflow) < 0.5 ? o : { ...o, [key]: overflow })),
  };
}

export function Marquee({
  id,
  text,
  group,
  style,
  height,
  background,
}: {
  id: string;
  text: string;
  group: MarqueeGroup;
  style: TextStyle;
  height: number;
  background: [number, number, number];
}) {
  const [box, setBox] = useState(0);
  const [natural, setNatural] = useState(0);
  const overflow = box > 0 && natural > box + 0.5 ? natural - box : 0;
  useEffect(() => group.report(id, overflow), [overflow]);
  const progress = group.progress;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: overflow ? -overflow * progress.get() : 0 }] }), [overflow]);
  const leading = useAnimatedStyle(() => ({ opacity: overflow ? interpolate(progress.get(), [0, 0.03], [0, 1], Extrapolation.CLAMP) : 0 }), [overflow]);
  const trailing = useAnimatedStyle(() => ({ opacity: overflow ? interpolate(progress.get(), [0.97, 1], [1, 0], Extrapolation.CLAMP) : 0 }), [overflow]);
  return (
    <View style={{ height, overflow: "hidden" }} onLayout={(e) => setBox(e.nativeEvent.layout.width)}>
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, height, width: 4000, flexDirection: "row", alignItems: "center" }, slide]}>
        <Text numberOfLines={1} onLayout={(e) => setNatural(e.nativeEvent.layout.width)} style={style}>
          {text}
        </Text>
      </Animated.View>
      {overflow ? (
        <>
          <Fade side="left" opacity={leading} background={background} height={height} />
          <Fade side="right" opacity={trailing} background={background} height={height} />
        </>
      ) : null}
    </View>
  );
}

function Fade({ side, opacity, background, height }: { side: "left" | "right"; opacity: ReturnType<typeof useAnimatedStyle>; background: [number, number, number]; height: number }) {
  const [r, g, b] = background;
  const w = FADE / FADE_STEPS;
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, [side]: 0, width: FADE, height, flexDirection: side === "left" ? "row" : "row-reverse" }, opacity]}>
      {Array.from({ length: FADE_STEPS }, (_, i) => (
        <View key={i} style={{ width: w, height, backgroundColor: `rgba(${r},${g},${b},${1 - (i + 0.5) / FADE_STEPS})` }} />
      ))}
    </Animated.View>
  );
}
