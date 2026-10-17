import { useState } from "react";
import { PanResponder, type GestureResponderHandlers } from "react-native";
import { cancelAnimation, Easing, runOnJS, useAnimatedReaction, useSharedValue, withTiming, type SharedValue } from "@bay/platform/motion";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { RESIZE_BAND, RESIZE_BAND_SCALE } from "./constants";

type ResizeOptions = {
  min: number;
  max: number;
  direction: 1 | -1;
  saved: () => number;
  onLive: (width: number | null) => void;
  onCommit: (width: number) => void;
};

/**
 * Dragging a panel's edge to resize it (the sidebar; the extension side panel can take it too). Past `min` or `max`
 * the edge stretches on a rubber band, and let go there it springs back into range. The width on screen is the one
 * fact: a grab starts from it, and stops a spring still settling, so a second drag never fights the first one's spring.
 * `direction`: 1 when dragging right widens the panel, -1 for a panel on the right. `onLive(null)` hands the width back
 * to the saved one, right after `onCommit` saved it.
 */
export function useResizeDrag(o: ResizeOptions): GestureResponderHandlers {
  const options = useEffectEvent(() => o);
  // The spring back into range runs on the UI thread; each of its frames sets the panel's width in JS.
  const springWidth = useSharedValue(0);
  const springing = useSharedValue(false);
  const [{ show, handlers }] = useState(() => resizeDrag(options, springWidth, springing));
  useAnimatedReaction(
    () => (springing.get() ? springWidth.get() : null),
    (width) => {
      if (width !== null) runOnJS(show)(width);
    },
  );
  return handlers;
}

function resizeDrag(options: () => ResizeOptions, springWidth: SharedValue<number>, springing: SharedValue<boolean>) {
  let live: number | null = null;
  let start = 0;
  const show = (width: number) => {
    live = width;
    options().onLive(width);
  };
  const commit = (width: number) => {
    live = null;
    options().onCommit(width);
    options().onLive(null);
  };
  const band = (over: number) => RESIZE_BAND * (1 - Math.exp(-over / RESIZE_BAND_SCALE));
  const unband = (stretch: number) => -RESIZE_BAND_SCALE * Math.log(1 - Math.min(stretch, RESIZE_BAND - 0.01) / RESIZE_BAND);
  const rubberBand = (width: number) => {
    const { min, max } = options();
    if (width > max) return max + band(width - max);
    if (width < min) return min - band(min - width);
    return width;
  };
  // The pointer position a width on screen stands for, so a grab mid-spring starts where the edge is.
  const unstretch = (width: number) => {
    const { min, max } = options();
    if (width > max) return max + unband(width - max);
    if (width < min) return min - unband(min - width);
    return width;
  };
  const clamp = (width: number) => Math.min(options().max, Math.max(options().min, width));
  const at = (dx: number) => rubberBand(start + options().direction * dx);
  const handlers = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      // Stopped, a spring's callback sees `finished: false` and commits nothing.
      springing.set(false);
      cancelAnimation(springWidth);
      start = unstretch(live ?? options().saved());
      show(rubberBand(start));
    },
    onPanResponderMove: (_, g) => show(at(g.dx)),
    onPanResponderRelease: (_, g) => {
      const raw = at(g.dx);
      const target = clamp(raw);
      if (raw === target) return commit(target);
      const settle = () => commit(target);
      springWidth.set(raw);
      springing.set(true);
      springWidth.set(
        withTiming(target, { duration: 260, easing: Easing.out(Easing.back(1.2)) }, (finished) => {
          if (!finished) return;
          springing.set(false);
          runOnJS(settle)();
        }),
      );
    },
    onPanResponderTerminate: () => commit(clamp(live ?? options().saved())),
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;
  return { show, handlers };
}
