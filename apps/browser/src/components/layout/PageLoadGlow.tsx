import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../../lib/theme";
import { useTabLive } from "../../store/hooks";

// Arc's loading indicator, for a page without a toolbar to carry one (the address in the sidebar, or full screen): a
// short pill (white, or grey in light mode) at the top centre of the page that springs a little wider and back while the page loads. No shadow:
// a shadow on a view Reanimated animates takes the app down on RN macOS (Paper), without a crash report.
const NARROW = 30;
const WIDE = 64;
// Snappy, with a little overshoot; it turns back once nearly settled, not after the spring's long tail.
const SPRING = { mass: 1, damping: 12, stiffness: 230, restDisplacementThreshold: 1, restSpeedThreshold: 6, reduceMotion: ReduceMotion.System };
const FADE = { duration: 220, reduceMotion: ReduceMotion.System };

export function PageLoadGlow({ tabId }: { tabId: string }) {
  const dark = useTheme().dark;
  const loading = useTabLive(tabId, (l) => l.isLoading);
  const width = useSharedValue(NARROW);
  const shown = useSharedValue(0);

  useEffect(() => {
    if (loading) {
      shown.set(withTiming(1, FADE));
      width.set(withRepeat(withSequence(withSpring(WIDE, SPRING), withSpring(NARROW, SPRING)), -1));
      return;
    }
    cancelAnimation(width);
    width.set(withSpring(NARROW, SPRING));
    shown.set(withTiming(0, FADE));
  }, [loading, width, shown]);

  const pillStyle = useAnimatedStyle(() => {
    "worklet";
    return { width: width.get(), opacity: shown.get() };
  });

  return (
    <View pointerEvents="none" style={styles.track}>
      <Animated.View style={[styles.pill, { backgroundColor: dark ? "#FFFFFF" : "#8E8E93" }, pillStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { position: "absolute", top: 3, left: 0, right: 0, alignItems: "center" },
  pill: {
    height: 3,
    borderRadius: 1.5,
  },
});
