import { isMac, Pressable, View } from "@bay/platform";
import { Surface } from "@bay/shell";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, { Easing, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "@bay/platform/motion";
import { hex, useTheme } from "../lib/theme";
import { browserRead, useBrowserRead } from "../store/read";
import { dispatchBrowserCommand } from "../runtime/commands";
import { DEFAULT_WINDOW_UI } from "../store/ui";
import { showToast } from "./layout/splitActions";
import { useWindowId } from "../store/hooks";
import { activeTabId } from "../store/model";
import { SWITCH_EASING } from "./layout/switchMotion";
import { PAGE_SWITCH_MS } from "./layout/constants";
import { useUrlAnchors } from "./layout/windowLayout";
import { Omnibox } from "./Omnibox";
import { PaletteSurface } from "./omnibox/PaletteSurface";
import { webviews } from "../lib/webviews";
import {
  DROPDOWN_MIN_WIDTH,
  DROPDOWN_PAST_FIELD,
  DROPDOWN_RADIUS,
  PANEL_ABOVE_PANE,
  PANEL_LEFT_OF_URL,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WINDOW_MARGIN,
} from "./omnibox/constants";

type NavigationInsets = { left?: number; right?: number; top?: number };

export function CommandPanel({
  windowWidth,
  windowHeight = 800,
  navigationInsets,
}: {
  windowWidth: number;
  windowHeight?: number;
  navigationInsets?: NavigationInsets;
}) {
  const theme = useTheme();
  const windowId = useWindowId();
  const panel = useBrowserRead((s) => (s.windowUi[windowId] ?? DEFAULT_WINDOW_UI).panel);
  // The active tab's id, and only while the panel is open: a closed panel doesn't re-render on tab switches.
  const activeId = useBrowserRead((s) => (panel.open ? activeTabId(s, windowId) : undefined));
  const anchor = useUrlAnchors((s) => (panel.open ? s[windowId] : undefined));
  const small = useBrowserRead((s) => s.windows[windowId]?.kind === "small");
  const session = panel.open && activeId && !small ? { key: panel.sessionId ?? activeId, tabId: activeId, initialText: panel.initialText } : null;
  // The palette last open: closed, it fades out as it faded in, so leaving a New Tab page it goes with the page's
  // crossfade rather than at once, which left the bare page on screen for a frame or two.
  const [last, setLast] = useState(session);
  if (session && session.key !== last?.key) setLast(session);
  // Native pages crossfade with the closing palette. Web pages can attach
  // before that animation finishes, so remove their palette on submission.
  const shown = session ?? (isMac ? last : null);
  if (shown) {
    return (
      <CenteredPalette
        key={shown.key}
        windowId={windowId}
        tabId={shown.tabId}
        width={windowWidth}
        height={windowHeight}
        navigationInsets={navigationInsets}
        initialText={shown.initialText}
        closing={!session}
        onClosed={() => setLast(null)}
      />
    );
  }
  if (!panel.open || !activeId || !anchor) return null;

  const room = (left: number, fallback: number) => (windowWidth > 0 ? windowWidth - left - PANEL_WINDOW_MARGIN : fallback);
  const onCancel = () => {
    void dispatchBrowserCommand({ method: "dismissCommandPanel", windowId }).catch((error) => {
      console.error("Couldn't close search", error);
      showToast(windowId, "Couldn't close search", "Please try again.");
    });
  };

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

  const left = Math.max(PANEL_WINDOW_MARGIN, anchor.left - PANEL_LEFT_OF_URL);
  const top = Math.max(0.5, anchor.top - PANEL_ABOVE_PANE);
  const fitted = Math.min(PANEL_MAX_WIDTH, anchor.width + PANEL_LEFT_OF_URL);
  const width = Math.min(Math.max(fitted, PANEL_MIN_WIDTH), room(left, fitted));
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

function CenteredPalette({
  windowId,
  tabId,
  width: windowWidth,
  height: windowHeight,
  navigationInsets,
  initialText,
  closing,
  onClosed,
}: {
  windowId: string;
  tabId: string;
  width: number;
  height: number;
  navigationInsets?: NavigationInsets;
  initialText: string;
  closing: boolean;
  onClosed: () => void;
}) {
  const theme = useTheme();
  const [height, setHeight] = useState(400);
  const appear = useSharedValue(0);
  useEffect(() => {
    if (!closing) {
      appear.set(withTiming(1, { duration: 150, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }));
      return;
    }
    // Out with a tab switch's crossfade (switchMotion.ts).
    appear.set(
      withTiming(0, { duration: PAGE_SWITCH_MS, easing: SWITCH_EASING, reduceMotion: ReduceMotion.System }, (finished) => {
        if (finished) runOnJS(onClosed)();
      }),
    );
  }, [appear, closing]);
  // It rises in as it opens; closing, it only fades (with the page under it), and its dim with it.
  const appearStyle = useAnimatedStyle(() => {
    "worklet";
    const p = appear.get();
    return { opacity: p, transform: [{ translateY: closing ? 0 : (1 - p) * 6 }] };
  }, [closing]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: closing ? appear.get() : 1 }), [closing]);
  const dismiss = async () => {
    try {
      await dispatchBrowserCommand({ method: "dismissCommandPanel", windowId });
      const active = activeTabId(browserRead.getState(), windowId);
      if (active) {
        const view = webviews.get(active);
        if (view) await view.focus();
      }
    } catch (error) {
      console.error("Couldn't close search", error);
      showToast(windowId, "Couldn't close search", "Please try again.");
    }
  };
  if (windowWidth < 1 || windowHeight < 1) return null;
  const width = Math.min(760, windowWidth - 32);
  const maxHeight = Math.max(160, Math.min(620, windowHeight - 56));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={closing ? "none" : "box-none"} accessibilityViewIsModal={!closing}>
      <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "#00000012" : "#00000006" }, dimStyle]}>
        {/* Navigation keeps its clicks: activating a tab also closes the palette. */}
        <Pressable accessibilityLabel="Dismiss search" onPress={dismiss} style={[StyleSheet.absoluteFill, navigationInsets]} />
      </Animated.View>
      <Animated.View style={[{ position: "absolute", width, left: (windowWidth - width) / 2, top: Math.max(16, (windowHeight - height) / 2) }, appearStyle]}>
        <PaletteSurface>
          <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
            <Omnibox variant="palette" tabId={tabId} initialText={initialText} onCancel={dismiss} maxHeight={maxHeight} width={width} />
          </View>
        </PaletteSurface>
      </Animated.View>
    </View>
  );
}
