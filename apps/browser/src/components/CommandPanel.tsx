import { Surface } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { hex, useTheme } from "../lib/theme";
import { useBrowser } from "../store/browser";
import { useWindowId, useWindowUi } from "../store/hooks";
import { activeTabId } from "../store/model";
import { useUrlAnchors } from "./layout/windowLayout";
import { Omnibox } from "./Omnibox";
import { PaletteSurface } from "./omnibox/PaletteSurface";
import { webviews } from "../lib/webviews";

// Dia: 37.4pt offset, 5.5pt rise, 888pt max, 12pt margin/radius.
const LEFT_OF_URL = 37.4;
const ABOVE_PANE = 5.5;
const MAX_WIDTH = 888;
const MIN_WIDTH = 420;
const WINDOW_MARGIN = 12;
const DROPDOWN_MIN_WIDTH = 350;
const DROPDOWN_PAST_FIELD = 137;
const DROPDOWN_RADIUS = 12;

export function CommandPanel({ windowWidth, windowHeight = 800 }: { windowWidth: number; windowHeight?: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { panel } = useWindowUi();
  // The active tab's id, and only while the panel is open: a closed panel doesn't re-render on tab switches.
  const activeId = useBrowser((s) => (panel.open ? activeTabId(s, windowId) : undefined));
  const anchor = useUrlAnchors((s) => (panel.open ? s[windowId] : undefined));
  const small = useBrowser((s) => s.windows[windowId]?.kind === "small");
  if (!panel.open || !activeId) return null;
  if (!small) return <CenteredPalette key={panel.sessionId ?? activeId} windowId={windowId} tabId={activeId} width={windowWidth} height={windowHeight} initialText={panel.initialText} />;
  if (!anchor) return null;

  const room = (left: number, fallback: number) => (windowWidth > 0 ? windowWidth - left - WINDOW_MARGIN : fallback);
  const onCancel = () => useBrowser.getState().closePanel(windowId);

  if (anchor.sidebar) {
    const width = Math.min(Math.max(DROPDOWN_MIN_WIDTH, anchor.width + DROPDOWN_PAST_FIELD), room(anchor.left, DROPDOWN_MIN_WIDTH));
    return (
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={DROPDOWN_RADIUS}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={24}
        shadowOffset={[0, 10]}
        style={{ position: "absolute", top: anchor.top, left: anchor.left, width }}
      >
        <Omnibox key={activeId} variant="sidebar" tabId={activeId} initialText={panel.initialText} onCancel={onCancel} />
      </Surface>
    );
  }

  const left = Math.max(WINDOW_MARGIN, anchor.left - LEFT_OF_URL);
  const top = Math.max(0.5, anchor.top - ABOVE_PANE);
  const fitted = Math.min(MAX_WIDTH, anchor.width + LEFT_OF_URL);
  const width = Math.min(Math.max(fitted, MIN_WIDTH), room(left, fitted));
  return (
    <Surface
      fill={hex(theme.panel)}
      cornerRadius={17}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity}
      shadowRadius={24}
      shadowOffset={[0, 10]}
      style={{ position: "absolute", top, left, width }}
    >
      <Omnibox key={activeId} variant="sidebar" tabId={activeId} initialText={panel.initialText} onCancel={onCancel} />
    </Surface>
  );
}


function CenteredPalette({ windowId, tabId, width: windowWidth, height: windowHeight, initialText }: {
  windowId: string;
  tabId: string;
  width: number;
  height: number;
  initialText: string;
}) {
  const theme = useTheme();
  const [height, setHeight] = useState(400);
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!live) return;
      if (reduced) appear.setValue(1);
      else Animated.timing(appear, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }, () => { if (live) appear.setValue(1); });
    return () => { live = false; appear.stopAnimation(); };
  }, [appear]);
  const dismiss = () => {
    useBrowser.getState().closePanel(windowId);
    const active = activeTabId(useBrowser.getState(), windowId);
    if (active) void webviews.get(active)?.focus();
  };
  if (windowWidth < 1 || windowHeight < 1) return null;
  const width = Math.min(760, windowWidth - 32);
  const maxHeight = Math.max(160, Math.min(600, windowHeight - 56));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal>
      <Pressable accessibilityLabel="Dismiss search" onPress={dismiss} style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "#00000012" : "#00000006" }]} />
      <Animated.View style={{ position: "absolute", width, left: (windowWidth - width) / 2, top: Math.max(16, (windowHeight - height) / 2), opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
        <PaletteSurface>
          <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
            <Omnibox variant="palette" tabId={tabId} initialText={initialText} onCancel={dismiss} maxHeight={maxHeight} width={width} />
          </View>
        </PaletteSurface>
      </Animated.View>
    </View>
  );
}
