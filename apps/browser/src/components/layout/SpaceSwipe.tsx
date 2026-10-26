import { View } from "@bay/platform";
import { SwipeArea, type SwipeAreaHandle, type SwipeEvent } from "@bay/nncore";
import { WindowBackdrop } from "@bay/shaders";
import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useEvent } from "@bay/platform/motion";
import { useShallow } from "zustand/react/shallow";
import { useHighContrast } from "../../lib/highContrast";
import { themeFor, themeKey } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { useWindowId } from "../../store/hooks";
import { pagerFor, usePagerNativeConfig, usePagerPages, usePagerSurface } from "./spacePager";

// `swipes` false keeps the children mounted without the swipe area: the peek has one only while it's out.
export function SpaceSwipe({ children, swipes = true }: { children: ReactNode; swipes?: boolean }) {
  return (
    <View style={{ height: "100%" }}>
      {children}
      {swipes ? <SpaceSwipeArea surface="sidebar" style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

export function SpaceSwipeArea({ surface, style, pageWidth }: { surface: "sidebar" | "strip"; style: StyleProp<ViewStyle>; pageWidth?: number }) {
  const windowId = useWindowId();
  usePagerSurface(windowId);
  const [previous, next, multiple] = useBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      const i = w && !w.incognito ? s.spaceOrder.indexOf(w.spaceId) : -1;
      return i < 0 ? [false, false, false] : [i > 0, i < s.spaceOrder.length - 1, s.spaceOrder.length > 1];
    }),
  );
  const area = useRef<SwipeAreaHandle>(null);
  const pager = pagerFor(windowId);
  const nativePager = usePagerNativeConfig(windowId, pageWidth);
  // On the UI thread, each frame the native pager moves: no JS on the way. The legacy bridge sends the frame as
  // topPagerPosition (RCTComponentEvent's name) and Reanimated matches it as sent there, so a handler on
  // onPagerPosition alone never ran and the sidebar stayed on the space it opened with.
  const pos = pager.pos;
  const onPagerPosition = useEvent<{ position: number }>(
    (event) => {
      "worklet";
      pos.set(event.position);
    },
    ["onPagerPosition", "topPagerPosition"],
  );

  const onSwipe = (event: SwipeEvent) => {
    if (__DEV__) {
      if (received.length >= 4096) received.shift();
      received.push({ at: performance.now(), surface, profile: useBrowser.getState().windows[windowId]?.spaceId, ...event });
    }
    const e = pageWidth ? { ...event, width: pageWidth } : event;
    if (e.phase === "swipe") return pager.step(e.direction === "back" ? -1 : 1);
    // Drags never need JS: the native pager tracks and settles them.
    if (e.phase === "wheel") pager.wheel(e);
  };

  useEffect(() => {
    if (!__DEV__) return;
    const key = `${surface}:${windowId}`;
    devAreas.set(key, area);
    return () => void (devAreas.get(key) === area && devAreas.delete(key));
  }, [windowId, surface]);

  // Keep the native controller configured when the last extra profile is removed, so its absolute
  // position returns to zero. The area stays transparent and recognizes no single-profile drags.
  if (!multiple && !nativePager) return null;
  return (
    <SwipeArea
      ref={area}
      style={style}
      canSwipeBack={previous}
      canSwipeForward={next}
      tracksUnavailableDirections={multiple}
      isPager={multiple}
      onSwipe={onSwipe}
      nativePager={nativePager}
      onPagerPosition={nativePager && onPagerPosition}
      onPagerState={nativePager && pager.onNativeState}
    />
  );
}

export function SpaceTint() {
  const windowId = useWindowId();
  const { pages, paging } = usePagerPages(windowId);
  const contrast = useHighContrast();
  const keys = useBrowser(useShallow((s) => pages.map((p) => themeKey(s, windowId, p.id, undefined, contrast))));
  if (!paging) return null;
  return (
    <>
      {pages.map((page, k) => {
        return <TintPage key={page.id} themeKey={keys[k]!} from={k === 0 ? null : pages[k - 1]!.slot} slot={page.slot} />;
      })}
    </>
  );
}

// A page's backdrop, coming in over the one before it as the pager reaches its slot (`from`: that one's, none for the
// first, always shown).
function TintPage({ themeKey, from, slot }: { themeKey: string; from: number | null; slot: number }) {
  const theme = themeFor(themeKey);
  const { pager } = usePagerPages(useWindowId());
  const pos = pager.pos;
  const style = useAnimatedStyle(() => ({ opacity: from === null ? 1 : interpolate(pos.get(), [from, slot], [0, 1], Extrapolation.CLAMP) }), [from, slot]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <WindowBackdrop vibrancy={theme.glass} {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const devAreas = new Map<string, React.RefObject<SwipeAreaHandle | null>>();
// DEV: every onSwipe JS received, to compare with the native emits.
const received: object[] = [];
if (__DEV__) {
  const g = globalThis as { nnSwipe?: Record<string, unknown> };
  g.nnSwipe = {
    ...g.nnSwipe,
    received: () => received.splice(0),
    sidebar: (windowId: string) => devAreas.get(`sidebar:${windowId}`)?.current ?? null,
    strip: (windowId: string) => devAreas.get(`strip:${windowId}`)?.current ?? null,
  };
}
