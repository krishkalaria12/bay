import { useEffect, useState } from "react";
import { Animated, Easing, type ViewStyle } from "react-native";
import { reduceMotion } from "../../lib/reduceMotion";
import { useBrowser, type BrowserState } from "../../store/browser";
import { activeTabId } from "../../store/model";
import { splitOf } from "../../store/splits";
import { sidebarTabOrder } from "../sidebar/entries";
import type { Rect } from "./geometry";
import { stripEntries } from "./stripGroups";

// A tab switch moves what it changes a little the way it went: down the sidebar (or right along the strip) the page
// comes up from below and the selection follows the rows down; back up, the other way round. Small and quick (only a
// fade with Reduce Motion), on a curve that leaves fast and lands soft.
export const SWITCH_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);

type Axis = "x" | "y";
// +1: the tab switched to is after the one left (below it, or right of it); -1 before it; 0 not known (a live
// folder's row, say): a dissolve.
type Switch = { from: string[]; to: string[]; direction: -1 | 0 | 1; axis: Axis; at: number };

// Panes and rows see a switch within a render or two; one showing a tab long after (full screen ending) isn't one.
const FRESH_MS = 500;
const switches = new Map<string, Switch>();

// The tabs a tab is shown with: its split's panes, or itself.
const shownWith = (s: BrowserState, tabId: string) => splitOf(s, tabId)?.tabIds ?? [tabId];

function tabOrder(s: BrowserState, windowId: string, strip: boolean): string[] {
  if (!strip) return sidebarTabOrder(s, windowId);
  const profileId = s.windows[windowId]?.profileId;
  if (!profileId) return [];
  return stripEntries(s, windowId, profileId).flatMap((entry) => {
    const [kind, id, tabs] = entry.split(":");
    return kind === "group" ? [] : kind === "split" ? tabs!.split(",") : [id!];
  });
}

function directionOf(s: BrowserState, prev: BrowserState, windowId: string, from: string, to: string, strip: boolean): Switch["direction"] {
  // Placed as they were, unless the tab switched to is new (a closed tab is still in the old order).
  const before = tabOrder(prev, windowId, strip);
  const order = before.includes(to) ? before : tabOrder(s, windowId, strip);
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  return a < 0 || b < 0 || a === b ? 0 : b > a ? 1 : -1;
}

useBrowser.subscribe((s, prev) => {
  if (s.windows === prev.windows) return;
  for (const [windowId, w] of Object.entries(s.windows)) {
    const was = prev.windows[windowId];
    if (!was || w === was) continue;
    const to = activeTabId(s, windowId);
    const from = activeTabId(prev, windowId);
    if (!to || !from || to === from) continue;
    // Another space pages in with its pager; a tab dragged to another window leaves the next one shown at once.
    const movedAway = !!s.tabs[from] && s.tabs[from].windowId !== windowId;
    if (w.profileId !== was.profileId || movedAway) {
      switches.delete(windowId);
      continue;
    }
    const strip = (w.tabLayout ?? s.settings.tabLayout) === "top";
    const direction = directionOf(s, prev, windowId, from, to, strip);
    switches.set(windowId, { from: shownWith(prev, from), to: shownWith(s, to), direction, axis: strip ? "x" : "y", at: Date.now() });
  }
});

// The window's latest switch, if it just happened.
function latestSwitch(windowId: string): Switch | null {
  const sw = switches.get(windowId);
  return sw && Date.now() - sw.at <= FRESH_MS ? sw : null;
}

// The window's switch onto (or off) any of `tabIds`, if it just happened.
function recentSwitch(windowId: string, side: "from" | "to", tabIds: string[]): Switch | null {
  const sw = latestSwitch(windowId);
  return sw && sw[side].some((id) => tabIds.includes(id)) ? sw : null;
}

type AnimatedStyle = Animated.WithAnimatedObject<ViewStyle>;

const fadeOut = (progress: Animated.Value) => progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

const slideStyle = (progress: Animated.Value, from: number, to: number, axis: Axis): AnimatedStyle => {
  const shift = progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
  return { transform: [axis === "x" ? { translateX: shift } : { translateY: shift }] };
};

// As yab switches pages: the page left stays on screen while the one switched to fades in over it (or it fades off
// the new one), and the new page settles a few points the way the switch went. Over in about six frames.
const PAGE_MS = 120;
const PAGE_OFFSET = 4;
// A pane faded off stays transparent this long after: its page hides a frame or two after the switch ends (native
// views apply their props apart from React's), and at full opacity meanwhile it flashed over the page switched to.
const SETTLE_MS = 250;
const GONE: AnimatedStyle = { opacity: 0 };

export type PaneSwitch = {
  // The panes switched away from, kept on screen where they were until the switch is over.
  leaving: Record<string, Rect>;
  entering: string[];
  // Each pane's part: whichever side is drawn on top fades, so the other shows through it.
  fade: Record<string, AnimatedStyle>;
  slide: AnimatedStyle;
  progress: Animated.Value;
  // Played: only the panes faded off are left, kept transparent while their pages hide.
  settled?: boolean;
};

/**
 * The switch between the panes the card shows, while it plays; null at rest. Only a switch that hands the card from
 * one tab (or split) to another plays: not a space's, not a split's focus moving between its panes, not a closed tab's
 * (nothing is left to show).
 */
export function usePaneSwitch(windowId: string, panes: Record<string, Rect>, enabled: boolean): PaneSwitch | null {
  // Not memoized by the compiler: which switch this is depends on when the render runs, not only on its arguments.
  "use no memo";
  const [before, setBefore] = useState(panes);
  const [played, setPlayed] = useState<Switch | null>(null);
  const [pane, setPane] = useState<PaneSwitch | null>(null);
  // Decided in the render that switches, so the first frame drawn is already the switch's.
  if (panes !== before) {
    setBefore(panes);
    const sw = latestSwitch(windowId);
    const entering = Object.keys(panes).filter((id) => !before[id]);
    const leaving = Object.keys(before).filter((id) => !panes[id]);
    // The card draws its panes oldest first (ContentCard); a tab gone from the store has no pane left.
    const tabs = useBrowser.getState().tabs;
    const createdAt = (ids: string[]) => ids.map((id) => tabs[id]?.createdAt ?? -1);
    const enteringAt = createdAt(entering);
    const leavingAt = createdAt(leaving);
    if (enabled && sw && sw !== played && entering.length && leaving.length && !leavingAt.includes(-1) && sw.to.some((id) => entering.includes(id))) {
      setPlayed(sw);
      const progress = new Animated.Value(0);
      const fadingIn = Math.max(...enteringAt) > Math.max(...leavingAt);
      const fadeStyle: AnimatedStyle = { opacity: fadingIn ? progress : fadeOut(progress) };
      const distance = reduceMotion() ? 0 : PAGE_OFFSET * sw.direction;
      setPane({
        leaving: Object.fromEntries(leaving.map((id) => [id, before[id]!])),
        entering,
        fade: Object.fromEntries((fadingIn ? entering : leaving).map((id) => [id, fadeStyle])),
        slide: slideStyle(progress, distance, 0, sw.axis),
        progress,
      });
    } else if (pane) {
      setPane(null);
    }
  }
  useEffect(() => {
    if (!pane) return;
    if (pane.settled) {
      const timer = setTimeout(() => setPane(null), SETTLE_MS);
      return () => clearTimeout(timer);
    }
    const run = Animated.timing(pane.progress, { toValue: 1, duration: PAGE_MS, easing: SWITCH_EASING, useNativeDriver: true });
    run.start(({ finished }) => {
      if (!finished) return;
      const fadedOff = Object.keys(pane.fade).filter((id) => pane.leaving[id]);
      setPane(fadedOff.length ? { ...pane, leaving: {}, entering: [], fade: Object.fromEntries(fadedOff.map((id) => [id, GONE])), settled: true } : null);
    });
    return () => run.stop();
  }, [pane]);
  return pane;
}

export type SwitchSlide = { progress: Animated.Value; style: AnimatedStyle };

export type SlideOptions = {
  // Where a thing coming on starts, in points along the switch's direction; one going off ends as far the other way.
  offset: number;
  duration: number;
  // The axis to slide on; the switch's own (the strip's, or the sidebar's) by default.
  axis?: Axis;
};

function makeSlide(sw: Switch, on: boolean, { offset, axis = sw.axis }: SlideOptions): SwitchSlide {
  const progress = new Animated.Value(0);
  const distance = reduceMotion() ? 0 : offset * sw.direction;
  const opacity = on ? progress : fadeOut(progress);
  return { progress, style: { opacity, ...slideStyle(progress, on ? distance : 0, on ? 0 : -distance, axis) } };
}

/**
 * The slide of something shown for `tabIds` as `on` turns, when a tab switch turned it; null at rest. Mounting on for
 * the tab just switched to counts as turning on.
 */
export function useSwitchSlide(windowId: string, tabIds: string[], on: boolean, options: SlideOptions): SwitchSlide | null {
  // Not memoized by the compiler: which switch this is depends on when the render runs, not only on its arguments.
  "use no memo";
  const [was, setWas] = useState(() => on && !recentSwitch(windowId, "to", tabIds));
  const [slide, setSlide] = useState<SwitchSlide | null>(null);
  // Decided in the render that turns it, so the first frame drawn is already the slide's.
  if (on !== was) {
    setWas(on);
    const sw = recentSwitch(windowId, on ? "to" : "from", tabIds);
    setSlide(sw ? makeSlide(sw, on, options) : null);
  }
  useEffect(() => {
    if (!slide) return;
    const run = Animated.timing(slide.progress, { toValue: 1, duration: options.duration, easing: SWITCH_EASING, useNativeDriver: true });
    run.start(({ finished }) => finished && setSlide(null));
    return () => run.stop();
  }, [slide]);
  return slide;
}
