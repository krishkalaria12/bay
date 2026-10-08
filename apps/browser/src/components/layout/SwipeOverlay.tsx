import { SwipeArea, swipeHaptic, type SwipeAreaHandle, type SwipeEvent } from "@bay/nncore";
import { Surface, Symbol, VisualEffect } from "@bay/shell";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { Favicon, NewTabIcon } from "../primitives";
import { HistoryPopover } from "./HistoryPopover";
import { goBack, goForward, goToHistoryItem, historyFavicons, historyItems, openHistoryMenu, useHistoryAvailability, useHistoryMenu, type HistoryItem } from "./history";
import type { ToolbarGeometry } from "./geometry";
import {
  CAPSULE_INSET,
  CAPSULE_SIZE,
  CAPSULE_SIZE_CONFIRMED,
  capsuleOffset,
  LIST_ROW,
  listSelection,
  springParams,
  swipeProgress,
} from "./swipeMotion";


const SIZE = CAPSULE_SIZE;
const SIZE_CONFIRMED = CAPSULE_SIZE_CONFIRMED;
const ICON = 28;
const ICON_CONFIRMED = 34;
const LIST_WIDTH = 200;
const ROW = LIST_ROW;
const LIST_PAD = 8;
const LIST_RADIUS = 18;
const LIST_IDLE_MS = 300;
const EASE = Easing.bezier(0.25, 0.46, 0.45, 0.94);

// The capsule's frame (x, w, h, top, radius) is layout; it moves on the UI thread with its opacity and transforms.
function spring(value: SharedValue<number>, toValue: number, response: number, dampingRatio: number) {
  value.set(withSpring(toValue, springParams(response, dampingRatio)));
}

export function NavigationOverlays({ tabId, windowId, geometry }: { tabId: string; windowId: string; geometry: ToolbarGeometry }) {
  return (
    <>
      <SwipeOverlay tabId={tabId} />
      <HistoryPopover tabId={tabId} windowId={windowId} anchors={{ back: geometry.back, forward: geometry.forward }} />
    </>
  );
}

type Shown = { direction: "back" | "forward"; confirmed: boolean; list: HistoryItem[] | null; selected: number };

export function SwipeOverlay({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const history = useHistoryAvailability(tabId);
  // Read by the gesture only: no render needs it.
  const areaHeight = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const area = useRef<SwipeAreaHandle>(null);

  const g = useRef({
    active: false,
    direction: "back" as "back" | "forward",
    confirmed: false,
    width: SIZE,
    items: null as Promise<HistoryItem[]> | null,
    list: null as HistoryItem[] | null,
    listY: 0,
    selected: 0,
    idle: undefined as ReturnType<typeof setTimeout> | undefined,
  }).current;
  const v = {
    x: useSharedValue(-SIZE),
    w: useSharedValue(SIZE),
    h: useSharedValue(SIZE),
    top: useSharedValue(0),
    nudge: useSharedValue(0),
    radius: useSharedValue(SIZE / 2),
    confirm: useSharedValue(0),
    icon: useSharedValue(1),
    list: useSharedValue(0),
    pill: useSharedValue(0),
    fade: useSharedValue(1),
    scale: useSharedValue(1),
  };

  // A new gesture stops everything the last one left running: its springs, its delayed dismiss and its list timer.
  const resetValues = (direction: "back" | "forward") => {
    for (const value of Object.values(v)) cancelAnimation(value);
    clearTimeout(g.idle);
    const height = areaHeight.current;
    v.x.set(-SIZE);
    v.w.set(SIZE);
    v.h.set(SIZE);
    v.top.set(height / 2 - SIZE / 2);
    v.nudge.set(0);
    v.radius.set(SIZE / 2);
    v.confirm.set(0);
    v.icon.set(1);
    v.list.set(0);
    v.pill.set(0);
    v.fade.set(1);
    v.scale.set(1);
    Object.assign(g, { active: true, direction, confirmed: false, width: SIZE, list: null, listY: 0, selected: 0 });
  };

  const layoutTo = (width: number, height: number, top: number, radius: number, response: number, ratio: number) => {
    g.width = width;
    spring(v.w, width, response, ratio);
    spring(v.h, height, response, ratio);
    spring(v.top, top, response, ratio);
    spring(v.radius, radius, response, ratio);
  };

  const setConfirmed = (confirmed: boolean) => {
    if (g.confirmed === confirmed) return;
    g.confirmed = confirmed;
    if (confirmed) swipeHaptic("levelChange");
    const height = areaHeight.current;
    if (!g.list) {
      const s = confirmed ? SIZE_CONFIRMED : SIZE;
      layoutTo(s, s, height / 2 - s / 2, s / 2, 0.18, 0.7);
      spring(v.icon, confirmed ? ICON_CONFIRMED / ICON : 1, 0.18, 0.7);
    }
    v.confirm.set(withTiming(confirmed ? 1 : 0, { duration: 180, easing: EASE }));
    setShown((s) => (s ? { ...s, confirmed } : s));
  };

  const presentList = async () => {
    const gesture = g.items;
    const items = (await gesture) ?? [];
    if (g.items !== gesture || !g.active || g.list || !g.confirmed || items.length < 2) return;
    const height = areaHeight.current;
    const fit = Math.max(2, Math.floor((height / 2 + ROW / 2 - LIST_PAD - 8) / ROW));
    const list = items.slice(0, fit);
    g.list = list;
    g.selected = 0;
    g.listY = lastDy.current;
    swipeHaptic("generic");
    layoutTo(LIST_WIDTH, list.length * ROW + LIST_PAD * 2, height / 2 - LIST_PAD - ROW / 2, LIST_RADIUS, 0.22, 0.77);
    v.list.set(withTiming(1, { duration: 220, easing: EASE }));
    setShown((s) => (s ? { ...s, list, selected: 0 } : s));
  };

  const select = (dy: number) => {
    const { index, nudge } = listSelection(dy - g.listY, g.list!.length);
    v.nudge.set(nudge);
    if (index === g.selected) return;
    g.selected = index;
    swipeHaptic("alignment");
    spring(v.pill, index * ROW, 0.27, 0.9);
    setShown((s) => (s ? { ...s, selected: index } : s));
  };

  const dismiss = (delay = 0) => {
    clearTimeout(g.idle);
    g.active = false;
    const out = (to: number, done?: () => void) =>
      withDelay(
        delay,
        withTiming(to, { duration: 200, easing: Easing.in(Easing.ease) }, (finished) => {
          if (finished && done) runOnJS(done)();
        }),
      );
    v.scale.set(out(0.01));
    v.fade.set(out(0, () => setShown(null)));
  };

  const lastDy = useRef(0);
  const onSwipe = (e: SwipeEvent) => {
    lastDy.current = e.dy;
    if (e.phase === "began" || e.phase === "swipe") {
      resetValues(e.direction);
      g.items = historyItems(tabId, e.direction === "back" ? -1 : 1);
      setShown({ direction: e.direction, confirmed: false, list: null, selected: 0 });
    }
    if (!g.active) return;
    if (e.phase === "swipe") {
      v.x.set(CAPSULE_INSET);
      setConfirmed(true);
      navigate(e.direction, null);
      // Confirmed for a moment, then gone; the delay is part of the animation, so the next gesture's reset stops it.
      return dismiss(120);
    }
    if (e.phase === "cancelled") return dismiss();
    if (e.phase === "ended") {
      const target = g.list ? (g.list[g.selected] ?? null) : null;
      if (target || g.confirmed) navigate(e.direction, target);
      return dismiss();
    }

    const progress = swipeProgress(e.distance);
    if (g.list) select(e.dy);
    else setConfirmed(progress >= 1);
    v.x.set(capsuleOffset(progress, g.width));

    clearTimeout(g.idle);
    if (g.confirmed && !g.list) g.idle = setTimeout(() => void presentList(), LIST_IDLE_MS);
  };

  const navigate = (direction: "back" | "forward", item: HistoryItem | null) => {
    if (item) return void goToHistoryItem(tabId, item);
    if (direction === "back") goBack(tabId);
    else goForward(tabId);
  };

  useEffect(() => () => clearTimeout(g.idle), []);
  useSwipeDevHandle(tabId, area);

  const back = shown?.direction !== "forward";
  // Every frame value, the unused side "auto": a value the style stops giving keeps the last one it gave.
  const frame = useAnimatedStyle(
    () => ({ left: back ? v.x.get() : "auto", right: back ? "auto" : v.x.get(), top: v.top.get() + v.nudge.get(), width: v.w.get(), height: v.h.get() }),
    [back],
  );
  const fadeStyle = useAnimatedStyle(() => ({ opacity: v.fade.get(), transform: [{ scale: v.scale.get() }] }));
  const radiusStyle = useAnimatedStyle(() => ({ borderRadius: v.radius.get() }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: v.confirm.get() }));
  const iconOpacity = useAnimatedStyle(() => ({ opacity: interpolate(v.confirm.get(), [0, 1], [0.5, 1]) * (1 - v.list.get()) }));
  const iconScale = useAnimatedStyle(() => ({ transform: [{ scale: v.icon.get() }] }));

  return (
    <>
      <SwipeArea
        ref={area}
        style={StyleSheet.absoluteFill}
        canSwipeBack={history.back}
        canSwipeForward={history.forward}
        allowsVerticalMotion={!!shown?.list}
        onSwipe={onSwipe}
        onLayout={(e) => {
          areaHeight.current = e.nativeEvent.layout.height;
        }}
      />
      {shown && (
        <Animated.View pointerEvents="none" style={[{ position: "absolute" }, frame]}>
          {/* The dismiss fade and shrink, apart from the frame. */}
          <Animated.View style={[StyleSheet.absoluteFill, fadeStyle]}>
            <Surface
              style={StyleSheet.absoluteFill}
              cornerRadius={shown.list ? LIST_RADIUS : (shown.confirmed ? SIZE_CONFIRMED : SIZE) / 2}
              shadowColor="#000000"
              shadowOpacity={theme.dark ? 0.25 : 0.2}
              shadowRadius={8}
              shadowOffset={[0, 2]}
            />
            <Animated.View style={[StyleSheet.absoluteFill, { overflow: "hidden" }, radiusStyle]}>
              <VisualEffect material="popover" style={StyleSheet.absoluteFill} />
              {!theme.dark && <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(255,255,255,0.4)" }, confirmStyle]} />}
              <Animated.View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }, iconOpacity]}>
                <Animated.View style={iconScale}>
                  <Symbol name={back ? "chevron.left" : "chevron.right"} size={ICON} weight="bold" color={theme.dark ? "#FFFFFFD9" : "#000000D9"} style={{ width: ICON + 6, height: ICON + 6 }} />
                </Animated.View>
              </Animated.View>
              {shown.list && <DestinationList tabId={tabId} items={shown.list} selected={shown.selected} appear={v.list} pill={v.pill} />}
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, { borderWidth: 1, borderColor: theme.dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.125)" }, radiusStyle]} />
          </Animated.View>
        </Animated.View>
      )}
    </>
  );
}

function DestinationList({ tabId, items, selected, appear, pill }: { tabId: string; items: HistoryItem[]; selected: number; appear: SharedValue<number>; pill: SharedValue<number> }) {
  const theme = useTheme();
  const profileId = useBrowser((s) => s.tabs[tabId]?.profileId ?? "");
  const favicons = useMemo(() => historyFavicons(profileId, items), [items, profileId]);
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.get(), transform: [{ scale: interpolate(appear.get(), [0, 1], [0.9, 1]) }] }));
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateY: pill.get() }] }));
  return (
    <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: LIST_WIDTH, paddingVertical: LIST_PAD }, appearStyle]}>
      <Animated.View
        style={[
          { position: "absolute", left: 8, right: 8, top: LIST_PAD, height: ROW, borderRadius: 10, backgroundColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)" },
          pillStyle,
        ]}
      />
      {items.map((item, i) => (
        <View key={item.key} style={{ height: ROW, flexDirection: "row", alignItems: "center", paddingHorizontal: 18, gap: 10 }}>
          <View style={{ width: 16, height: 16, borderRadius: 4, overflow: "hidden" }}>
            {item.offset === "newTab" ? <NewTabIcon size={16} /> : <Favicon url={item.url} favicon={favicons.get(item.url) ?? null} size={16} />}
          </View>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: i === selected ? theme.textPrimary : theme.textSecondary }}>
            {item.title}
          </Text>
        </View>
      ))}
    </Animated.View>
  );
}

const devPanes = new Map<string, React.RefObject<SwipeAreaHandle | null>>();
function useSwipeDevHandle(tabId: string, area: React.RefObject<SwipeAreaHandle | null>) {
  useEffect(() => {
    if (!__DEV__) return;
    devPanes.set(tabId, area);
    return () => void (devPanes.get(tabId) === area && devPanes.delete(tabId));
  }, [tabId]);
}
if (__DEV__) {
  const g = globalThis as { nnSwipe?: Record<string, unknown> };
  g.nnSwipe = { ...g.nnSwipe, pane: (tabId: string) => devPanes.get(tabId)?.current ?? null, history: { items: historyItems, open: openHistoryMenu, menu: useHistoryMenu, go: goToHistoryItem } };
}
