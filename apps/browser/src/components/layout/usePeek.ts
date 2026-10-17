import { useEffect, useRef, useState } from "react";
import { Easing, ReduceMotion, runOnJS, useSharedValue, withTiming, type WithTimingConfig } from "@bay/platform/motion";

export const SLIDE_MS = 180;
// The sidebar's and tab strip's slides: the peek's and the docked sidebar's. Instant under Reduce Motion.
export const SLIDE: WithTimingConfig = { duration: SLIDE_MS, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };
const HIDE_DELAY_MS = 120;

/**
 * A hidden sidebar or tab strip peeking out while the pointer is at the window's edge. The peek stays mounted, so a
 * reveal only slides it in: it never re-measures, remounts its rows or loses its scroll. `live`: it takes the pointer,
 * from the moment it starts showing until it has slid all the way out (coming back mid-slide keeps it).
 */
export function usePeek(enabled: boolean) {
  const slide = useSharedValue(0);
  const [live, setLive] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const slideOut = () => {
    slide.set(withTiming(0, SLIDE, (finished) => {
      if (finished) runOnJS(setLive)(false);
    }));
  };
  const show = () => {
    clearTimeout(hideTimer.current);
    if (!enabled) return;
    setLive(true);
    slide.set(withTiming(1, SLIDE));
  };
  const hide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(slideOut, HIDE_DELAY_MS);
  };
  useEffect(() => {
    if (enabled) return;
    clearTimeout(hideTimer.current);
    slideOut();
  }, [enabled]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  return { slide, live, show, hide };
}
