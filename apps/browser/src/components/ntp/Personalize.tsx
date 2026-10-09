import { Surface, Symbol } from "@bay/shell";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { create } from "zustand";
import { hex, useTheme } from "../../lib/theme";
import { PERSONALIZE_COPY, TabLayoutPicker, ThemeColorPicker } from "../onboarding/personalize";
import { useHover } from "../primitives";
import { GLYPH_DROP, PERSONALIZE_BUTTON, PERSONALIZE_INSET, PERSONALIZE_SPRING } from "./constants";

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
      <View {...hoverProps} tooltip="Personalize" style={{ position: "absolute", right: PERSONALIZE_INSET, bottom: PERSONALIZE_INSET - GLYPH_DROP }}>
        <Pressable onPress={() => setOpen(open ? null : windowId)} accessibilityRole="button" accessibilityLabel="Personalize" accessibilityState={{ expanded: open }}>
          {({ pressed }) => (
            <View
              style={{
                width: PERSONALIZE_BUTTON,
                height: PERSONALIZE_BUTTON,
                borderRadius: PERSONALIZE_BUTTON / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.toolbarPressed : hovered || open ? theme.toolbarHover : undefined,
              }}
            >
              <Symbol name="paintpalette" size={14} color={hovered || open ? theme.icon : theme.textTertiary} style={{ width: PERSONALIZE_BUTTON, height: PERSONALIZE_BUTTON }} />
            </View>
          )}
        </Pressable>
      </View>
    </>
  );
}

function PersonalizePanel({ windowId, onClose }: { windowId: string; onClose: () => void }) {
  const theme = useTheme();
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withSpring(1, PERSONALIZE_SPRING));
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
          right: PERSONALIZE_INSET,
          bottom: PERSONALIZE_INSET + PERSONALIZE_BUTTON + 8,
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
