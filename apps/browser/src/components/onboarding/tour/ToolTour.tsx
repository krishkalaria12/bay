import { Surface } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { hex, useTheme } from "../../../lib/theme";
import { useWindowId } from "../../../store/hooks";
import type { Rect } from "../../layout/geometry";
import { useHover } from "../../primitives";
import { useOnboardingColors } from "../ui";
import { locateAnchor } from "./anchors";
import { endToolTour, openVideoTour, stepToolTour, useTour, videoTourUrl, type TourStop } from "./state";
import { TOUR_CARD_WIDTH, TOUR_GAP, TOUR_MARGIN, TOUR_SCRIM_REACH, TOUR_SPOT_SPRING } from "../constants";

export function ToolTour() {
  const windowId = useWindowId();
  const active = useTour((s) => s.windowId === windowId && s.stops.length > 0);
  const session = useTour((s) => s.session);
  const [shown, setShown] = useState<number | null>(null);
  const presence = useSharedValue(0);

  useEffect(() => {
    if (active) {
      setShown(session);
      presence.set(withTiming(1, { duration: 240, easing: Easing.out(Easing.quad) }));
    } else if (shown !== null) {
      const gone = () => setShown(null);
      presence.set(
        withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }, (finished) => {
          if (finished) runOnJS(gone)();
        }),
      );
    }
  }, [active, session]);
  const presenceStyle = useAnimatedStyle(() => ({ opacity: presence.get() }));

  if (shown === null) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, presenceStyle]} pointerEvents={active ? "box-none" : "none"}>
      <Tour key={shown} windowId={windowId} />
    </Animated.View>
  );
}

type Hole = Rect & { radius: number };
type HoleValues = { x: SharedValue<number>; y: SharedValue<number>; w: SharedValue<number>; h: SharedValue<number>; r: SharedValue<number> };

function Tour({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const stops = useTour((s) => s.stops);
  const index = useTour((s) => s.index);
  const stop = stops[Math.min(index, stops.length - 1)];
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [target, setTarget] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(150);
  const hole: HoleValues = { x: useSharedValue(0), y: useSharedValue(0), w: useSharedValue(0), h: useSharedValue(0), r: useSharedValue(0) };
  const card = { x: useSharedValue(0), y: useSharedValue(0) };
  const placed = useRef(false);

  useEffect(() => {
    if (!stop?.anchor) return setTarget(null);
    let cancelled = false;
    const update = () =>
      void locateAnchor(windowId, stop.anchor!).then((rect) => {
        if (!cancelled) setTarget((prev) => (sameRect(prev, rect) ? prev : rect));
      });
    update();
    const timer = setInterval(update, 400);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stop?.id, windowId]);

  const spot = spotlight(stop, target, size);
  const cardAt = placeCard(stop, spot, size, cardHeight);

  useEffect(() => {
    if (!size.width || !stop) return;
    const to = { x: spot.x, y: spot.y, w: spot.width, h: spot.height, r: spot.radius };
    const cardTo = { x: cardAt.x, y: cardAt.y };
    if (!placed.current) {
      placed.current = true;
      (Object.keys(to) as (keyof typeof to)[]).forEach((k) => hole[k].set(to[k]));
      card.x.set(cardTo.x);
      card.y.set(cardTo.y);
      return;
    }
    // Layout (left/top/width/height), and the radius Ring follows.
    const spring = (v: SharedValue<number>, toValue: number) => v.set(withSpring(toValue, TOUR_SPOT_SPRING));
    (Object.keys(to) as (keyof typeof to)[]).forEach((k) => spring(hole[k], to[k]));
    spring(card.x, cardTo.x);
    spring(card.y, cardTo.y);
  }, [spot.x, spot.y, spot.width, spot.height, spot.radius, cardAt.x, cardAt.y, size.width, !!stop]);

  // The scrim: a frame whose border reaches past the window, around the hole, and four panes that take the clicks.
  const frame = useAnimatedStyle(() => ({
    left: hole.x.get() - TOUR_SCRIM_REACH,
    top: hole.y.get() - TOUR_SCRIM_REACH,
    width: hole.w.get() + TOUR_SCRIM_REACH * 2,
    height: hole.h.get() + TOUR_SCRIM_REACH * 2,
    borderRadius: hole.r.get() + TOUR_SCRIM_REACH,
  }));
  const above = useAnimatedStyle(() => ({ height: hole.y.get() }));
  const below = useAnimatedStyle(() => ({ top: hole.y.get() + hole.h.get() }));
  const leftOf = useAnimatedStyle(() => ({ width: hole.x.get(), top: hole.y.get(), height: hole.h.get() }));
  const rightOf = useAnimatedStyle(() => ({ left: hole.x.get() + hole.w.get(), top: hole.y.get(), height: hole.h.get() }));
  const cardStyle = useAnimatedStyle(() => ({ left: card.x.get(), top: card.y.get() }));
  if (!stop) return null;
  const scrim = theme.dark ? "#00000080" : "#0000004D";

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", borderWidth: TOUR_SCRIM_REACH, borderColor: scrim, overflow: "hidden" }, frame]} />
      <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 0 }, above]} />
      <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0 }, below]} />
      <Animated.View style={[{ position: "absolute", left: 0 }, leftOf]} />
      <Animated.View style={[{ position: "absolute", right: 0 }, rightOf]} />
      {stop.anchor ? <Ring hole={hole} /> : null}
      <Animated.View
        style={[{ position: "absolute", width: TOUR_CARD_WIDTH }, cardStyle]}
        onLayout={(e) => setCardHeight(Math.round(e.nativeEvent.layout.height))}
      >
        <CoachMark stop={stop} index={index} count={stops.length} windowId={windowId} />
      </Animated.View>
    </View>
  );
}

function Ring({ hole }: { hole: HoleValues }) {
  const pulse = useSharedValue(0);
  const [r, setR] = useState(() => hole.r.get());
  // The rim's corner is a native view's prop: each frame of the radius comes back to JS.
  useAnimatedReaction(
    () => hole.r.get(),
    (value) => {
      runOnJS(setR)(Math.max(0, value));
    },
  );
  useEffect(() => {
    const leg = (to: number) => withTiming(to, { duration: 1100, easing: Easing.inOut(Easing.sin) });
    pulse.set(withRepeat(withSequence(leg(1), leg(0)), -1, false));
    return () => cancelAnimation(pulse);
  }, []);
  const out = 3;
  const frame = useAnimatedStyle(() => ({ left: hole.x.get() - out, top: hole.y.get() - out, width: hole.w.get() + out * 2, height: hole.h.get() + out * 2 }));
  const pulseStyle = useAnimatedStyle(() => ({ opacity: interpolate(pulse.get(), [0, 1], [0.45, 1]) }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute" }, frame]}>
      <Animated.View style={[StyleSheet.absoluteFill, pulseStyle]}>
        <Surface style={StyleSheet.absoluteFill} cornerRadius={r + out} borderWidth={1.5} borderColor="#FFFFFFB3" />
      </Animated.View>
    </Animated.View>
  );
}

function CoachMark({ stop, index, count, windowId }: { stop: TourStop; index: number; count: number; windowId: string }) {
  const theme = useTheme();
  const last = index === count - 1;
  const video = last ? videoTourUrl() : null;
  return (
    <Surface
      fill={hex(theme.panel)}
      cornerRadius={14}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity}
      shadowRadius={24}
      shadowOffset={[0, 10]}
    >
      <View style={{ paddingHorizontal: 18, paddingTop: 15, paddingBottom: 14, gap: 7 }} accessibilityRole="none">
        <Text style={{ fontSize: 10.5, fontWeight: "600", letterSpacing: 0.4, color: theme.textTertiary }}>
          {`${index + 1} OF ${count}`}
        </Text>
        <Text style={{ fontSize: 15, fontWeight: "600", letterSpacing: -0.1, color: theme.textPrimary }}>{stop.title}</Text>
        <Text style={{ fontSize: 12.5, lineHeight: 18, color: theme.textSecondary }}>{stop.body}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 7, gap: 6 }}>
          {last ? null : <TextButton title="Skip Tour" onPress={endToolTour} />}
          <View style={{ flex: 1 }} />
          {video ? <PillButton title="Watch Video Tour" onPress={() => (endToolTour(), openVideoTour(windowId))} /> : null}
          {index > 0 && !last ? <PillButton title="Back" onPress={() => stepToolTour(-1)} /> : null}
          <PillButton title={last ? "Done" : "Next"} primary onPress={() => stepToolTour(1)} />
        </View>
      </View>
    </Surface>
  );
}

function PillButton({ title, onPress, primary }: { title: string; onPress: () => void; primary?: boolean }) {
  const colors = useOnboardingColors();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              height: 28,
              borderRadius: 14,
              paddingHorizontal: 13,
              justifyContent: "center",
              backgroundColor: primary ? (hovered ? colors.primaryHover : colors.primary) : hovered ? colors.buttonHover : colors.button,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: primary ? colors.primaryText : colors.buttonText }}>{title}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function TextButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        <Text style={{ fontSize: 12, fontWeight: "500", color: hovered ? theme.textPrimary : theme.textTertiary, paddingVertical: 6 }}>{title}</Text>
      </Pressable>
    </View>
  );
}

// MARK: Geometry

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

function spotlight(stop: TourStop | undefined, target: Rect | null, size: { width: number; height: number }): Hole {
  if (!stop?.anchor || !target) return { x: size.width / 2, y: size.height / 2, width: 0, height: 0, radius: 0 };
  const pad = stop.pad ?? 4;
  return { x: target.x - pad, y: target.y - pad, width: target.width + pad * 2, height: target.height + pad * 2, radius: (stop.radius ?? 8) + Math.max(0, pad) };
}

function placeCard(stop: TourStop | undefined, spot: Hole, size: { width: number; height: number }, height: number) {
  const clampX = (x: number) => Math.min(Math.max(x, TOUR_MARGIN), Math.max(TOUR_MARGIN, size.width - TOUR_CARD_WIDTH - TOUR_MARGIN));
  const clampY = (y: number) => Math.min(Math.max(y, TOUR_MARGIN), Math.max(TOUR_MARGIN, size.height - height - TOUR_MARGIN));
  const centre = { x: clampX(size.width / 2 - TOUR_CARD_WIDTH / 2), y: clampY(size.height * 0.62 - height / 2) };
  if (!stop?.anchor || !spot.width) return centre;
  switch (stop.placement) {
    case "right": {
      const x = spot.x + spot.width + TOUR_GAP;
      if (x + TOUR_CARD_WIDTH > size.width - TOUR_MARGIN) return { x: clampX(spot.x), y: clampY(spot.y + spot.height + TOUR_GAP) };
      return { x, y: clampY(spot.y + spot.height / 2 - 36) };
    }
    case "inside":
      return { x: clampX(spot.x + spot.width / 2 - TOUR_CARD_WIDTH / 2), y: clampY(spot.y + spot.height * 0.7 - height / 2) };
    default: {
      const below = spot.y + spot.height + TOUR_GAP;
      const y = below + height > size.height - TOUR_MARGIN ? spot.y - TOUR_GAP - height : below;
      const x = spot.width < TOUR_CARD_WIDTH / 2 ? spot.x - 10 : spot.x + spot.width / 2 - TOUR_CARD_WIDTH / 2;
      return { x: clampX(x), y: clampY(y) };
    }
  }
}
