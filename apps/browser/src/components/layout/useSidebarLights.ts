import { setTrafficLightsCenter } from "@bay/shell";
import { useEffect, useRef } from "react";
import { interpolate, runOnJS, useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { layout } from "../../lib/constants";

// The window buttons' centre from the sidebar's top-left: AppKit's spot in the window (NNCoreChromeWindow.mm), so the
// header lays out as it does with the sidebar on the left.
const LIGHTS: readonly [number, number] = [25, 27];
// The peek's distance from the window's edge (App.tsx's SidebarPeek).
const PEEK_EDGE = 6;

/**
 * With the sidebar on the window's right and the address bar in it, the window buttons sit in the sidebar's header,
 * as they do on the left, and travel with it as it docks and undocks (with the peek while that's out). Elsewhere
 * they're left where the window puts them.
 */
export function useSidebarLights(
  windowId: string,
  o: { on: boolean; progress: SharedValue<number>; windowWidth: number; sidebarWidth: number; peekOut: boolean },
) {
  const { progress, windowWidth, sidebarWidth, peekOut } = o;
  const on = o.on && windowWidth > 0;
  const sent = useRef("");
  const place = (left: number, top: number) => {
    const center: [number, number] = [Math.round((left + LIGHTS[0]) * 2) / 2, top + LIGHTS[1]];
    const key = center.join(",");
    if (key === sent.current) return;
    sent.current = key;
    void setTrafficLightsCenter(windowId, center);
  };
  // The docked sidebar's left edge: the slot narrows to the card's inset as it closes (App.tsx's slotStyle).
  useAnimatedReaction(
    () => (on && !peekOut ? progress.get() : -1),
    (p) => {
      if (p >= 0) runOnJS(place)(windowWidth - interpolate(p, [0, 1], [layout.cardInset, sidebarWidth]), 0);
    },
    [windowId, on, peekOut, windowWidth, sidebarWidth],
  );
  useEffect(() => {
    if (on && peekOut) place(windowWidth - PEEK_EDGE - sidebarWidth, layout.cardTop);
  }, [windowId, on, peekOut, windowWidth, sidebarWidth]);
  useEffect(() => {
    if (!on) return;
    return () => {
      sent.current = "";
      void setTrafficLightsCenter(windowId, null);
    };
  }, [windowId, on]);
}
