import { Surface, Symbol } from "@bay/shell";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { tensionSpring } from "../../lib/springs";
import { create } from "zustand";
import { hex, useTheme } from "../../lib/theme";
import { PERSONALIZE_COPY, TabLayoutPicker, ThemeColorPicker } from "../onboarding/personalize";
import { useHover } from "../primitives";

const INSET = 16;
const BUTTON = 30;
// The palette glyph is wider than tall: drop the button so its visible gaps to the right and bottom edges match.
const GLYPH_DROP = 1.5;

const usePanel = create<{ windowId: string | null }>(() => ({ windowId: null }));
const setOpen = (windowId: string | null) => usePanel.setState({ windowId });

export function PersonalizeButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const open = usePanel((s) => s.windowId === windowId);
  useEffect(() => () => {
    if (usePanel.getState().windowId === windowId) setOpen(null);
  }, [windowId]);
  return (
    <>
      {open ? <PersonalizePanel windowId={windowId} onClose={() => setOpen(null)} /> : null}
      <View {...hoverProps} tooltip="Personalize" style={{ position: "absolute", right: INSET, bottom: INSET - GLYPH_DROP }}>
        <Pressable onPress={() => setOpen(open ? null : windowId)} accessibilityRole="button" accessibilityLabel="Personalize" accessibilityState={{ expanded: open }}>
          {({ pressed }) => (
            <View
              style={{
                width: BUTTON,
                height: BUTTON,
                borderRadius: BUTTON / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.toolbarPressed : hovered || open ? theme.toolbarHover : undefined,
              }}
            >
              <Symbol name="paintpalette" size={14} color={hovered || open ? theme.icon : theme.textTertiary} style={{ width: BUTTON, height: BUTTON }} />
            </View>
          )}
        </Pressable>
      </View>
    </>
  );
}

// Animated's old spring: tension 90, friction 9.
const PANEL_SPRING = tensionSpring(90, 9);

function PersonalizePanel({ windowId, onClose }: { windowId: string; onClose: () => void }) {
  const theme = useTheme();
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withSpring(1, PANEL_SPRING));
  }, []);
  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.get(), [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(t.get(), [0, 1], [8, 0]) }, { scale: interpolate(t.get(), [0, 1], [0.97, 1]) }],
  }));
  return (
    <>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close Personalize" />
      <Animated.View
        style={[{
          position: "absolute",
          right: INSET,
          bottom: INSET + BUTTON + 8,
          width: 352,
        }, panelStyle]}
      >
        <Surface
          fill={hex(theme.panel)}
          cornerRadius={16}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={24}
          shadowOffset={[0, 10]}
        >
          <View style={{ padding: 18, gap: 16 }}>
            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{PERSONALIZE_COPY.title}</Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: theme.textSecondary }}>{PERSONALIZE_COPY.subtitle}</Text>
            </View>
            <ThemeColorPicker windowId={windowId} size={28} />
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, color: theme.textSecondary }}>{PERSONALIZE_COPY.layouts}</Text>
              <TabLayoutPicker windowId={windowId} />
            </View>
          </View>
        </Surface>
      </Animated.View>
    </>
  );
}

if (__DEV__) (globalThis as { nnPersonalize?: unknown }).nnPersonalize = { open: setOpen };
