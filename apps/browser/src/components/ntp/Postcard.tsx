import { WindowBackdrop } from "@bay/shaders";
import { Surface, Symbol, VisualEffect } from "@bay/shell";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { hex, SPACE_COLORS, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { useHover } from "../primitives";
import type { ReleaseNotes } from "./releaseNotes";
import { APP_ICON } from "../../lib/assets";
import { POSTCARD, POSTCARD_HOVER_SLOP, POSTCARD_INK, POSTCARD_PAGE_SPRING, POSTCARD_PAPER, POSTCARD_TOOLTIP } from "./constants";


const cardFrame = (size: { width: number }) => ({
  x: size.width + POSTCARD.overhangRight - POSTCARD.width,
  y: -POSTCARD.overhangTop,
  width: POSTCARD.width,
  height: POSTCARD.height,
});

function useArtworkColors(): [string, string] {
  const windowId = useWindowId();
  const color = useBrowser((s) => s.spaces[s.windows[windowId]?.spaceId ?? ""]?.color ?? "plum");
  const swatch = SPACE_COLORS[color]?.swatch ?? SPACE_COLORS.plum.swatch;
  return [mix(swatch, "#FFFFFF", 0.45), mix(swatch, "#10121A", 0.5)];
}

function mix(a: string, b: string, t: number) {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function ReleaseNotesPostcard({ notes, size, onOpen, onDismiss }: { notes: ReleaseNotes; size: { width: number; height: number }; onOpen: () => void; onDismiss: () => void }) {
  const { hovered, hoverProps } = useHover();
  const drop = useSharedValue(1);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);
  const tooltip = useSharedValue(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) return drop.set(0), opacity.set(1);
      const stiffness = (2 * Math.PI / 0.65) ** 2;
      drop.set(withSpring(0, { stiffness, damping: 2 * Math.sqrt(stiffness), mass: 1 }));
      opacity.set(withTiming(1, { duration: 300, easing: Easing.out(Easing.quad) }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scale.set(withTiming(hovered ? 1.05 : 1, { duration: 160, easing: Easing.out(Easing.quad) }));
    tooltip.set(withTiming(hovered ? 1 : 0, { duration: hovered ? 50 : 100, easing: Easing.out(Easing.quad) }));
  }, [hovered]);

  const dismiss = () => {
    setLeaving(true);
    scale.set(withTiming(0.96, { duration: 200, easing: Easing.in(Easing.quad) }));
    opacity.set(
      withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }, () => {
        runOnJS(onDismiss)();
      }),
    );
  };
  const dropStyle = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: drop.get() * -280 }] }));
  const cardStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${POSTCARD.tilt}deg` }, { scale: scale.get() }] }));
  const tooltipStyle = useAnimatedStyle(() => ({ opacity: tooltip.get() }));
  if (size.height < 420 || size.width < 560) return null;

  const card = cardFrame(size);
  return (
    <Animated.View
      pointerEvents={leaving ? "none" : "box-none"}
      style={[
        {
          position: "absolute",
          left: card.x - POSTCARD_HOVER_SLOP,
          top: card.y - POSTCARD_HOVER_SLOP,
          width: card.width + POSTCARD_HOVER_SLOP * 2,
          height: card.height + POSTCARD_HOVER_SLOP + POSTCARD_TOOLTIP.gap + POSTCARD_TOOLTIP.height,
        },
        dropStyle,
      ]}
    >
      <View {...hoverProps} style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[{ position: "absolute", left: POSTCARD_HOVER_SLOP, top: POSTCARD_HOVER_SLOP, width: card.width, height: card.height }, cardStyle]}
        >
          <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="What's new in Bay" style={{ flex: 1 }}>
            <Surface
              style={StyleSheet.absoluteFill}
              cornerRadius={POSTCARD.radius}
              fill="#00000000"
              shadowColor="#000000"
              shadowOpacity={0.3}
              shadowRadius={20}
              shadowOffset={[0, -6]}
            />
            <Artwork notes={notes} radius={POSTCARD.radius} titleSize={40} hidden={{ top: POSTCARD.overhangTop, right: POSTCARD.overhangRight }} />
          </Pressable>
        </Animated.View>
        <Animated.View
          pointerEvents={hovered ? "box-none" : "none"}
          style={[{ position: "absolute", left: 0, right: 0, top: POSTCARD_HOVER_SLOP + card.height + POSTCARD_TOOLTIP.gap, alignItems: "center" }, tooltipStyle]}
        >
          <Tooltip text="Latest Release Notes" onOpen={onOpen} onClose={dismiss} />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

function Tooltip({ text, onOpen, onClose }: { text: string; onOpen: () => void; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={text}>
      <View style={{ height: POSTCARD_TOOLTIP.height, borderRadius: 6, overflow: "hidden", flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 3 }}>
        <VisualEffect material="contentBackground" blendingMode="withinWindow" cornerRadius={6} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.8)" }]} />
        <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "500", color: "rgba(255,255,255,0.85)", marginRight: 9 }}>
          {text}
        </Text>
        <CloseButton onPress={onClose} label="Dismiss release notes" size={22} radius={8} />
      </View>
    </Pressable>
  );
}

function CloseButton({ onPress, label, size, radius }: { onPress: () => void; label: string; size: number; radius: number }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={label}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {({ pressed }) => (
          <View
            style={{
              width: size,
              height: size,
              borderRadius: radius,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: `rgba(255,255,255,${pressed ? 0.3 : hovered ? 0.2 : 0.1})`,
            }}
          >
            <Symbol name="xmark" size={11} weight="medium" color="#FFFFFF8C" style={{ width: size, height: size }} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

function Artwork({ notes, radius, titleSize, hidden }: { notes: ReleaseNotes; radius: number; titleSize: number; hidden?: { top: number; right: number } }) {
  const colors = useArtworkColors();
  const k = titleSize / 44;
  const pad = 22 * k;
  return (
    <View style={{ flex: 1, borderRadius: radius, overflow: "hidden", backgroundColor: mix(colors[0], colors[1], 0.5) }}>
      <WindowBackdrop colors={colors} angle={150} grainOpacity={0.1} style={StyleSheet.absoluteFill} />
      <View style={{ flex: 1, padding: pad, paddingTop: pad + (hidden?.top ?? 0), paddingRight: pad + (hidden?.right ?? 0), justifyContent: "space-between" }}>
        <Text style={{ fontSize: 11.5 * k, fontWeight: "700", letterSpacing: 1.4 * k, color: "#FFFFFFCC" }}>{`BAY ${notes.version}`}</Text>
        <Text style={{ fontSize: titleSize, fontWeight: "300", fontStyle: "italic", letterSpacing: -1.1 * k, color: "#FFFFFF" }}>{"What's new"}</Text>
      </View>
    </View>
  );
}

export function ReleaseNotesPage({ notes, size, onClose }: { notes: ReleaseNotes; size: { width: number; height: number }; onClose: () => void }) {
  const theme = useTheme();
  const t = useSharedValue(0);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    t.set(withSpring(1, POSTCARD_PAGE_SPRING));
    return onClose;
  }, []);
  const close = () => {
    setClosing(true);
    t.set(
      withTiming(0, { duration: 240, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(onClose)();
      }),
    );
  };

  const width = Math.min(860, size.width - 64);
  const height = Math.min(520, size.height - 64, width * 0.62);
  const split = width >= 640;
  const card = cardFrame(size);
  const from = { x: card.x + card.width / 2 - size.width / 2, y: card.y + card.height / 2 - size.height / 2 };
  const backdrop = useAnimatedStyle(() => ({ opacity: interpolate(t.get(), [0, 1], [0, 1], Extrapolation.CLAMP) }));
  // From the postcard's place, size and tilt to the page's.
  const page = useAnimatedStyle(() => {
    const p = t.get();
    return {
      opacity: interpolate(p, [0, 0.3, 1], [0, 1, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: interpolate(p, [0, 1], [from.x, 0]) },
        { translateY: interpolate(p, [0, 1], [from.y, 0]) },
        { scale: interpolate(p, [0, 1], [POSTCARD.width / width, 1]) },
        { rotate: `${interpolate(p, [0, 1], [POSTCARD.tilt, -1])}deg` },
      ],
    };
  }, [from.x, from.y, width]);

  return (
    <Animated.View style={StyleSheet.absoluteFill} pointerEvents={closing ? "none" : "auto"}>
      <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
        <VisualEffect material="hudWindow" blendingMode="withinWindow" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(10,10,10,0.35)" : "rgba(255,255,255,0.35)" }]} />
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close release notes" />
      </Animated.View>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="box-none">
        <Animated.View style={[{ width, height }, page]}>
          <Surface
            style={StyleSheet.absoluteFill}
            fill={POSTCARD_PAPER}
            cornerRadius={6}
            borderColor="#00000014"
            borderWidth={0.5}
            shadowColor="#000000"
            shadowOpacity={0.3}
            shadowRadius={40}
            shadowOffset={[0, 18]}
          />
          <View style={{ flex: 1, flexDirection: split ? "row" : "column", padding: 16, gap: 22 }}>
            <View style={split ? { width: "46%" } : { height: 150 }}>
              <Artwork notes={notes} radius={4} titleSize={46} />
            </View>
            <View style={{ flex: 1, paddingTop: 10, paddingRight: 8 }}>
              <Stamp />
              <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 1.2, color: `${POSTCARD_INK}80`, marginRight: 116 }}>{notes.date.toUpperCase()}</Text>
              <Text style={{ fontSize: 26, fontWeight: "300", letterSpacing: -0.5, color: POSTCARD_INK, marginTop: 6, marginRight: 116 }}>{notes.title}</Text>
              <Text style={{ fontSize: 13, lineHeight: 19, color: `${POSTCARD_INK}B3`, marginTop: 8, marginRight: 116 }}>{notes.summary}</Text>
              <ScrollView style={{ flex: 1, marginTop: 14 }} contentContainerStyle={{ gap: 12, paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
                {notes.items.map((item) => (
                  <View key={item.title} style={{ gap: 2, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth * 2, borderBottomColor: `${POSTCARD_INK}14` }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: POSTCARD_INK }}>{item.title}</Text>
                    <Text style={{ fontSize: 12.5, lineHeight: 18, color: `${POSTCARD_INK}99` }}>{item.body}</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
          <View style={{ position: "absolute", right: -13, top: -13 }}>
            <PageCloseButton onPress={close} />
          </View>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

function PageCloseButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const label = "Close release notes";
  return (
    <View {...hoverProps} tooltip={label}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {({ pressed }) => (
          <Surface
            fill={hex(theme.panel)}
            cornerRadius={13}
            borderColor={hex(theme.panelBorder)}
            borderWidth={0.5}
            shadowColor="#000000"
            shadowOpacity={0.2}
            shadowRadius={6}
            shadowOffset={[0, 2]}
            style={{ width: 26, height: 26, transform: [{ scale: pressed ? 0.94 : 1 }] }}
          >
            <Symbol name="xmark" size={10} weight="semibold" color={hovered ? theme.textPrimary : theme.textSecondary} style={{ width: 26, height: 26 }} />
          </Surface>
        )}
      </Pressable>
    </View>
  );
}

function Stamp() {
  return (
    <View style={{ position: "absolute", right: 0, top: 0, width: 110, height: 86 }} pointerEvents="none">
      <View style={{ position: "absolute", right: 0, top: 0, padding: 4, borderWidth: 1.5, borderStyle: "dashed", borderColor: `${POSTCARD_INK}33`, borderRadius: 3, backgroundColor: "#FFFFFF" }}>
        <Image source={APP_ICON} style={{ width: 54, height: 54 }} />
      </View>
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 18,
          width: 58,
          height: 58,
          borderRadius: 29,
          borderWidth: 1.2,
          borderColor: `${POSTCARD_INK}59`,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ rotate: "-14deg" }],
        }}
      >
        <Text style={{ fontSize: 6.5, fontWeight: "700", letterSpacing: 0.6, color: `${POSTCARD_INK}80` }}>{"WHAT'S NEW"}</Text>
      </View>
    </View>
  );
}
