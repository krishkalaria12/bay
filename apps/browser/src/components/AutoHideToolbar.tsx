import { breadcrumb } from "@bay/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { reduceMotion } from "../lib/reduceMotion";
import { layout, useTheme } from "../lib/theme";
import { useBrowser } from "../store/browser";
import { useSettings, useTabLive } from "../store/hooks";
import type { ToolbarGeometry } from "./layout/geometry";
import { toolbarPalette, useEasedColor, useEasedColorStyle } from "./layout/toolbarColors";
import { useHistoryMenu } from "./layout/history";
import { usePages } from "./layout/pageState";
import { needsBar, revealToolbar, setToolbarPeek, STRIP_HEIGHT, toolbarMode, useToolbarAutoHide, type ToolbarMode } from "./layout/toolbarAutoHide";
import { Toolbar } from "./Toolbar";

// The toolbar that hides while scrolling (layout/toolbarAutoHide.ts), drawn over the top of its pane, with the page
// placed under it by useToolbarMotion.
//
// Hiding and showing don't resize the page: a page that sizes things to the viewport (vh units, a canvas re-created
// on resize) would redraw, and a WebGL canvas cleared by its resize shows blank for a frame (bay.com's Big Yahu
// blinked on every hide and show in 0.2.23). So once a pane's bar has first hidden, its page keeps the strip's size
// until the next document: the bar shown slides it down and its bottom goes under the card's edge (the link status
// bubble stays above it). Each motion is one transform on the UI thread, from where the layout moved the page (set in
// the commit's layout effect, so they land in the same frame) to its place; a reversal carries on from where the page is.

// Dia (owner's clip, 60 fps): the page's top glides up over ~150 ms, eased out (17, 32, 49, 68, 76, 88, 93, 95,
// 100 % per frame); the controls are gone in ~5 frames (45, 25, 11, 3 % left). Showing mirrors it, a little longer and
// softer at the end so the page settles rather than snaps, the controls fading and growing back in.
const HIDE_MS = 150;
const HIDE_EASING = Easing.out(Easing.quad);
const SHOW_MS = 200;
const SHOW_EASING = Easing.out(Easing.cubic);
// Resting on the strip this long peeks the bar (crossing it on the way to the tab strip doesn't).
const PEEK_DELAY = 150;
const UNPEEK_DELAY = 250;
const SHRINK = 0.94;
// What the page gets back from the bar itself.
const BAR_ROOM = layout.toolbarHeight - STRIP_HEIGHT;

export function useToolbarMode(tabId: string, windowId: string, enabled: boolean): ToolbarMode {
  const scrolledDown = useToolbarAutoHide((s) => !!s.scrolledDown[tabId]);
  const peek = useToolbarAutoHide((s) => !!s.peek[tabId]);
  const hasPage = useBrowser((s) => !!s.tabs[tabId]?.url);
  // Only asked while the bar is down, so a closed panel or find bar elsewhere doesn't re-render every pane.
  const appNeedsBar = useBrowser((s) => enabled && scrolledDown && needsBar(s, tabId, windowId));
  const popover = usePages((s) => enabled && scrolledDown && !!s.popover[tabId]);
  const historyMenu = useHistoryMenu((m) => enabled && scrolledDown && m.menu?.tabId === tabId);
  return toolbarMode({ enabled, hasPage, scrolledDown, peek, needsBar: appNeedsBar || popover || historyMenu });
}

export type ToolbarMotion = {
  // 0: the full bar's band and controls, 1: the strip.
  bar: SharedValue<number>;
  // The controls' fade (0 shown), apart from the band so Reduce Motion can fade without moving anything.
  fade: SharedValue<number>;
  // The page group (a bookmarks bar under the toolbar, then the page): where its layout puts it, and the transform to
  // where it shows.
  groupStyle: StyleProp<ViewStyle>;
  pageHeight: number;
  // For what sits at the bottom of the page (the link status bubble): kept above the card's edge while part of the
  // page is under it.
  bottomStyle: StyleProp<ViewStyle>;
};

// The pane's layout and motion with a toolbar that hides (`enabled`: the pane places its page with it, shown or not).
// `extra`: a bookmarks bar under the toolbar, which goes with the bar. `doc`: the page's document (its URL without the
// fragment); a new one gets the shown bar's size again.
export function useToolbarMotion({
  enabled,
  mode,
  height,
  extra,
  doc,
}: {
  enabled: boolean;
  mode: ToolbarMode;
  height: number;
  extra: number;
  doc: string;
}): ToolbarMotion {
  const collapsed = mode !== "shown";
  const hidden = mode === "collapsed";
  const shownTop = layout.toolbarHeight + extra;
  const room = shownTop - STRIP_HEIGHT;
  // The strip's size from the first hide (the one resize, held in place by the transform like any other move) until
  // the next document. A page that never scrolls far enough to hide the bar keeps all of it in view. Set while
  // rendering, so the layout changes in the commit that starts the motion.
  const [tallState, setTall] = useState({ on: collapsed, doc });
  let tall = tallState;
  if (tall.doc !== doc || (!enabled && tall.on)) tall = { on: false, doc };
  if (enabled && collapsed && !tall.on) tall = { on: true, doc };
  if (tall !== tallState) setTall(tall);

  // Where the page shows (0: under the full bar, 1: under the strip) and where its layout puts it (same scale).
  const page = useSharedValue(collapsed ? 1 : 0);
  const laid = useSharedValue(collapsed ? 1 : 0);
  const bar = useSharedValue(hidden ? 1 : 0);
  const fade = useSharedValue(hidden ? 1 : 0);
  const tallOn = tall.on;
  const shift = useAnimatedStyle(() => ({ transform: [{ translateY: (laid.get() - page.get()) * room }] }), [room]);
  // The page's bottom is room × (1 − page) under the card's edge while it keeps the strip's size.
  const bottomStyle = useAnimatedStyle(() => ({ transform: [{ translateY: tallOn ? (page.get() - 1) * room : 0 }] }), [tallOn, room]);
  const was = useRef({ collapsed, hidden });
  // A layout effect: its writes go out with this commit, so the layout's move and the transform holding the page
  // where it was land in the same frame. A new timing starts from where the value is, so a reversal mid-motion never
  // jumps.
  useLayoutEffect(() => {
    const before = was.current;
    was.current = { collapsed, hidden };
    if (before.collapsed === collapsed && before.hidden === hidden) return;
    const glide = (value: number, show: boolean) => withTiming(value, { duration: show ? SHOW_MS : HIDE_MS, easing: show ? SHOW_EASING : HIDE_EASING });
    if (before.collapsed !== collapsed) {
      const to = collapsed ? 1 : 0;
      const barTo = hidden ? 1 : 0;
      laid.set(to);
      if (reduceMotion()) {
        // The page and the band move at once, the controls fade.
        page.set(to);
        bar.set(barTo);
        fade.set(glide(barTo, !collapsed));
      } else {
        page.set(glide(to, !collapsed));
        bar.set(glide(barTo, !collapsed));
        fade.set(glide(barTo, !collapsed));
      }
    } else if (!hidden) {
      // Peeking: the bar over the page, at once.
      bar.set(0);
      fade.set(0);
    } else if (reduceMotion()) {
      bar.set(1);
      fade.set(glide(1, false));
    } else {
      bar.set(glide(1, false));
      fade.set(glide(1, false));
    }
  }, [collapsed, hidden]);

  return {
    bar,
    fade,
    groupStyle: [{ position: "absolute", left: 0, right: 0, top: (collapsed ? STRIP_HEIGHT : shownTop) - extra }, shift],
    pageHeight: height - (tall.on ? STRIP_HEIGHT : shownTop),
    bottomStyle,
  };
}

export function AutoHideToolbar({
  tabId,
  windowId,
  geometry,
  inSplit,
  focused,
  mode,
  motion,
}: {
  tabId: string;
  windowId: string;
  geometry: ToolbarGeometry;
  inSplit: boolean;
  focused: boolean;
  mode: ToolbarMode;
  motion: ToolbarMotion;
}) {
  const theme = useTheme();
  const url = useBrowser((s) => s.tabs[tabId]?.url ?? "");
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const extendColor = useSettings((s) => s.extendWebsiteColor);
  const palette = toolbarPalette(theme, extendColor && url ? themeColor : null);
  const band = useEasedColorStyle(useEasedColor(palette.background), "backgroundColor");
  const collapsed = mode === "collapsed";
  const modeNow = useRef(mode);
  modeNow.current = mode;

  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const peekLater = (on: boolean, ms: number) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setToolbarPeek(tabId, on), ms);
  };

  const { bar, fade } = motion;
  const H = layout.toolbarHeight;
  // The band: the bar's height down to the strip's, its top edge fixed (scaled about its middle, then lifted).
  const bandStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(bar.get(), [0, 1], [0, -BAR_ROOM / 2]) }, { scaleY: interpolate(bar.get(), [0, 1], [1, STRIP_HEIGHT / H]) }],
  }));
  const dividerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(bar.get(), [0, 1], [0, -BAR_ROOM]) }] }));
  const controlsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(fade.get(), [0, 0.2, 0.4, 0.6, 1], [1, 0.45, 0.15, 0, 0]),
    // Toward the top centre: scaled about its middle, then lifted so its top edge stays put, and a little more.
    transform: [{ translateY: interpolate(bar.get(), [0, 1], [0, -((1 - SHRINK) * H) / 2 - 3]) }, { scale: interpolate(bar.get(), [0, 1], [1, SHRINK]) }],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: interpolate(fade.get(), [0, 0.5, 1], [0, 0, 1]) }));
  const host = url.startsWith("file:") ? "File" : breadcrumb(url).host;

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: H }}>
      {/* The band, the card under it first: a peeking bar covers the page, and a website colour never fades out. */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, top: 0, height: H, backgroundColor: theme.card }, bandStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, band]} />
      </Animated.View>
      {url ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", left: 0, right: 0, top: H - StyleSheet.hairlineWidth, height: StyleSheet.hairlineWidth, backgroundColor: palette.divider }, dividerStyle]}
        />
      ) : null}
      <Animated.View
        pointerEvents={collapsed ? "none" : "box-none"}
        onMouseEnter={() => modeNow.current === "peek" && clearTimeout(peekTimer.current)}
        onMouseLeave={() => modeNow.current === "peek" && peekLater(false, UNPEEK_DELAY)}
        style={[{ position: "absolute", left: 0, right: 0, top: 0, height: H }, controlsStyle]}
      >
        <Toolbar tabId={tabId} geometry={geometry} windowId={windowId} inSplit={inSplit} focused={focused} bare />
      </Animated.View>
      <Animated.View pointerEvents={collapsed ? "auto" : "none"} style={[{ position: "absolute", left: 0, right: 0, top: 0, height: STRIP_HEIGHT }, labelStyle]}>
        <Pressable
          onPress={() => {
            clearTimeout(peekTimer.current);
            revealToolbar(tabId);
          }}
          onMouseEnter={() => modeNow.current === "collapsed" && peekLater(true, PEEK_DELAY)}
          onMouseLeave={() => modeNow.current === "collapsed" && clearTimeout(peekTimer.current)}
          tooltip="Show Toolbar"
          style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}
        >
          <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "500", color: palette.secondary }}>
            {host}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}
