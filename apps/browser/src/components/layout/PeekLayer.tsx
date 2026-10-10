import { Surface, Symbol } from "@bay/shell";
import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { layout } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { webviews } from "../../lib/webviews";
import { useBrowser } from "../../store/browser";
import type { Peek } from "../../store/peeks";
import { useHover } from "../primitives";
import type { Rect } from "./geometry";
import { PEEK_BUTTON, PEEK_CARD_GAP, PEEK_INSET_MIN, PEEK_INSET_SHARE, PEEK_OPEN_MS } from "./constants";

// Arc's Peek, over the page it was opened from (store/peeks.ts): the page dims away, the link's page sits on it in a
// card nearly its size, and beside the card are buttons for Close, Open as Tab and Split View (their names are their
// tooltips). A click on the dimmed page, Esc
// (TabWebView's escape) or ⌘W closes it; ⌘O keeps it (lib/commands.ts).

const ARRIVE = Easing.bezier(0.2, 0.8, 0.2, 1);
// A little rounder than the page under it, as a card on top.
const CARD_RADIUS = layout.cardRadius + 2;

let started = false;
/** A peek goes with its window, or with the tab it came from (closed, or moved to another window). */
export function startPeeks() {
  if (started) return;
  started = true;
  useBrowser.subscribe((s, prev) => {
    if (s.peeks === prev.peeks && s.tabs === prev.tabs && s.windows === prev.windows) return;
    for (const [windowId, peek] of Object.entries(s.peeks)) {
      const from = s.tabs[peek.fromId];
      if (!s.windows[windowId] || !from || from.windowId !== windowId) useBrowser.getState().closePeek(windowId);
    }
  });
}

export function PeekLayer({ windowId, peek, rect, children }: { windowId: string; peek: Peek; rect: Rect; children: ReactNode }) {
  const theme = useTheme();
  const close = () => useBrowser.getState().closePeek(windowId);
  const inset = Math.round(Math.max(PEEK_INSET_MIN, rect.width * PEEK_INSET_SHARE));

  // In: the dim and the card fade up together, the card rising a little; each new peek plays it again.
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.set(0);
    shown.set(withTiming(1, { duration: PEEK_OPEN_MS, easing: ARRIVE }));
  }, [peek.tabId]);
  const dim = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const card = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: (1 - shown.get()) * 14 }] }));

  // Its page takes the keys, as a tab's does when shown: try until its view is ready.
  useEffect(() => {
    const timers = [0, 120, 360].map((ms) => setTimeout(() => void webviews.get(peek.tabId)?.focus(), ms));
    return () => timers.forEach(clearTimeout);
  }, [peek.tabId]);

  return (
    <View style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: layout.cardRadius, overflow: "hidden" }, dim]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Peek"
          onPress={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(22,22,24,0.84)" : "rgba(238,238,241,0.86)" }]}
        />
      </Animated.View>

      {/* The card's shadow is the native Surface's, as every panel's here (a view's own shadow props crash AppKit). */}
      <Animated.View style={[{ position: "absolute", left: inset, right: inset, top: PEEK_CARD_GAP, bottom: PEEK_CARD_GAP }, card]}>
        <Surface
          fill={theme.dark ? "#1E1E20" : "#FFFFFF"}
          cornerRadius={CARD_RADIUS}
          borderColor={theme.panelBorder}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={28}
          shadowOffset={[0, 12]}
          style={StyleSheet.absoluteFill}
        />
        <View style={{ flex: 1, borderRadius: CARD_RADIUS, overflow: "hidden" }}>{children}</View>
      </Animated.View>

      <Animated.View style={[{ position: "absolute", top: PEEK_CARD_GAP, left: rect.width - inset + 10, right: 6, gap: 10 }, card]}>
        <PeekButton icon="xmark" label="Close" tooltip="Close Peek (⌘W)" onPress={close} />
        <PeekButton
          icon="arrow.up.left.and.arrow.down.right"
          label="Open as Tab"
          tooltip="Open as Tab (⌘O)"
          onPress={() => useBrowser.getState().keepPeek(windowId)}
        />
        <PeekButton icon="rectangle.split.2x1" label="Split View" tooltip="Open in Split View" onPress={() => useBrowser.getState().splitPeek(windowId)} />
      </Animated.View>
    </View>
  );
}

function PeekButton({ icon, label, tooltip, onPress }: { icon: string; label: string; tooltip: string; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const face = hovered ? (theme.dark ? "#3A3A3D" : "#F2F2F4") : theme.panel;
  return (
    <View tooltip={tooltip} {...hoverProps} style={{ alignSelf: "flex-start" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
        {({ pressed }) => (
          <Surface
            fill={face}
            cornerRadius={PEEK_BUTTON / 2}
            borderColor={theme.panelBorder}
            borderWidth={0.5}
            shadowColor="#000000"
            shadowOpacity={theme.panelShadowOpacity * 0.6}
            shadowRadius={4}
            shadowOffset={[0, 1]}
            style={{ width: PEEK_BUTTON, height: PEEK_BUTTON, alignItems: "center", justifyContent: "center", transform: [{ scale: pressed ? 0.92 : 1 }] }}
          >
            <Symbol name={icon} size={11} weight="semibold" color={theme.textPrimary} style={{ width: 14, height: 14 }} />
          </Surface>
        )}
      </Pressable>
    </View>
  );
}
