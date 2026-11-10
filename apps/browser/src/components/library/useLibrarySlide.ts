import { useEffect, useState } from "react";
import { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "@bay/platform/motion";
import type { Section } from "./sections";
import { useLibrarySidebar } from "./sidebarState";

const SLIDE = { duration: 280, easing: Easing.bezier(0.22, 1, 0.36, 1) };

// How far each side travels as the other replaces it.
const LIBRARY_TRAVEL = 44;
const TABS_TRAVEL = 28;

/**
 * The Library coming into the sidebar's place and leaving it: the slot widens or narrows as the Library slides in from
 * the window's edge and the tabs give way, and the reverse on the way out. While it leaves, it keeps the section and
 * width it had, so it doesn't change under the animation.
 */
export function useLibrarySlide(windowId: string, sidebarWidth: number, right: boolean) {
  const current = useLibrarySidebar((l) => l[windowId]);
  const open = !!current;
  const [shown, setShown] = useState<{ section: Section; width: number } | null>(current ? { section: current, width: sidebarWidth } : null);

  if (current && (shown?.section !== current || shown.width !== sidebarWidth)) setShown({ section: current, width: sidebarWidth });
  // The tabs stay mounted under the Library, keeping their scroll and rows; once covered they're taken out of layout.
  const [covered, setCovered] = useState(open);

  if (!open && covered) setCovered(false);

  const progress = useSharedValue(open ? 1 : 0);
  const slotWidth = useSharedValue(sidebarWidth);
  const [wasOpen, setWasOpen] = useState(open);

  if (wasOpen !== open) setWasOpen(open);
  // A resize handle's drag follows the pointer; only the Library's own changes of width are animated.
  const animateWidth = open || wasOpen;

  useEffect(() => {
    slotWidth.set(animateWidth ? withTiming(sidebarWidth, SLIDE) : sidebarWidth);
  }, [sidebarWidth, animateWidth, slotWidth]);

  useEffect(() => {
    const settle = () => {
      if (open) setCovered(true);
      else setShown(null);
    };

    progress.set(
      withTiming(open ? 1 : 0, SLIDE, (finished) => {
        if (finished) runOnJS(settle)();
      }),
    );
  }, [open, progress]);

  const side = right ? 1 : -1;
  const slotStyle = useAnimatedStyle(() => ({ width: slotWidth.get() }));

  const tabsStyle = useAnimatedStyle(() => {
    const p = progress.get();

    return { opacity: interpolate(p, [0, 0.6], [1, 0], "clamp"), transform: [{ translateX: -side * TABS_TRAVEL * p }] };
  });

  const libraryStyle = useAnimatedStyle(() => {
    const p = progress.get();

    return { opacity: interpolate(p, [0.2, 1], [0, 1], "clamp"), transform: [{ translateX: side * LIBRARY_TRAVEL * (1 - p) }] };
  });

  return { open, shown, covered, slotWidth, slotStyle, tabsStyle, libraryStyle };
}
