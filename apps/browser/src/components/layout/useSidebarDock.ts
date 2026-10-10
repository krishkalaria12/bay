import { useEffect, useState } from "react";
import { runOnJS, useSharedValue, withTiming } from "react-native-reanimated";
import { SLIDE } from "./usePeek";

/**
 * The docked sidebar opening (0 → 1) and closing (1 → 0), with the peek's timing. It animates the sidebar's slot width,
 * so the page beside it widens and narrows with it. `mounted` keeps the sidebar rendered until it has slid all the way
 * out. A window opens in its saved state, without animating.
 */
export function useSidebarDock(open: boolean) {
  const progress = useSharedValue(open ? 1 : 0);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    progress.set(
      withTiming(open ? 1 : 0, SLIDE, (finished) => {
        if (finished && !open) runOnJS(setMounted)(false);
      }),
    );
  }, [open, progress]);
  return { progress, mounted: open || mounted };
}
