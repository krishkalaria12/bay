import { useLayoutEffect, useState } from "react";
import type { ViewStyle } from "react-native";
import { cancelAnimation, Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
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
// folder's row, say): a dissolve. `closed`: the tab left was closed (its row fades out on its own, RowMotion).
type Switch = { from: string[]; to: string[]; direction: -1 | 0 | 1; axis: Axis; at: number; closed: boolean };

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
    switches.set(windowId, { from: shownWith(prev, from), to: shownWith(s, to), direction, axis: strip ? "x" : "y", at: Date.now(), closed: !s.tabs[from] });
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

// As yab switches pages: the page left stays on screen while the one switched to fades in over it (or it fades off
// the new one), and the new page settles a few points the way the switch went. Over in about six frames.
const PAGE_MS = 120;
const PAGE_OFFSET = 4;
// A pane faded off stays transparent this long after: its page hides a frame or two after the switch ends (native
// views apply their props apart from React's), and at full opacity meanwhile it flashed over the page switched to.
const SETTLE_MS = 250;
const GONE: ViewStyle = { opacity: 0 };

export type SwitchStyle = ViewStyle | ReturnType<typeof useAnimatedStyle> | (ViewStyle | ReturnType<typeof useAnimatedStyle>)[];

// An animated style that starts a switch, with its first frame's values after it: a Reanimated style attached in the
// middle of things gives React the values it had when it was made (the last switch's end), and the pane drew them for
// a frame before its UI-thread frames took over. React puts these in the switch's own commit, and doesn't send them
// again while they stay the same.
const starting = (animated: ReturnType<typeof useAnimatedStyle>, first: ViewStyle): SwitchStyle => [animated, first];
const shiftAt = (shift: number, horizontal: boolean): ViewStyle => ({ transform: horizontal ? [{ translateX: shift }] : [{ translateY: shift }] });

export type PaneSwitch = {
  // The panes switched away from, kept on screen where they were until the switch is over.
  leaving: Record<string, Rect>;
  entering: string[];
  // Each pane's part: whichever side is drawn on top fades, so the other shows through it.
  fade: Record<string, SwitchStyle>;
  slide: SwitchStyle;
  // Played: only the panes faded off are left, kept transparent while their pages hide.
  settled?: boolean;
  // Where the page switched to starts, along the switch's axis.
  shift: number;
  horizontal: boolean;
};

// A slide's shift: `from` points at the start to `to` at the end, along x or y.
const shiftStyle = (progress: number, from: number, to: number, horizontal: boolean) => {
  "worklet";
  const shift = interpolate(progress, [0, 1], [from, to]);
  return { transform: horizontal ? [{ translateX: shift }] : [{ translateY: shift }] };
};

/**
 * The switch between the panes the card shows, while it plays; null at rest. Only a switch that hands the card from
 * one tab (or split) to another plays: not a space's, not a split's focus moving between its panes, not a closed tab's
 * (nothing is left to show).
 */
export function usePaneSwitch(windowId: string, panes: Record<string, Rect>, enabled: boolean): PaneSwitch | null {
  // Not memoized by the compiler: which switch this is depends on when the render runs, not only on its arguments.
  "use no memo";
  const progress = useSharedValue(1);
  const distance = useSharedValue(0);
  const horizontal = useSharedValue(false);
  const fadeIn = useAnimatedStyle(() => ({ opacity: progress.get() }));
  const fadeOff = useAnimatedStyle(() => ({ opacity: 1 - progress.get() }));
  const slide = useAnimatedStyle(() => shiftStyle(progress.get(), distance.get(), 0, horizontal.get()));
  const [before, setBefore] = useState(panes);
  const [played, setPlayed] = useState<Switch | null>(null);
  const [pane, setPane] = useState<PaneSwitch | null>(null);
  // Decided in the render that switches, so the commit that shows the panes carries the switch's first frame.
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
      const fadingIn = Math.max(...enteringAt) > Math.max(...leavingAt);
      const shift = reduceMotion() ? 0 : PAGE_OFFSET * sw.direction;
      const fade = fadingIn ? starting(fadeIn, { opacity: 0 }) : starting(fadeOff, { opacity: 1 });
      setPane({
        leaving: Object.fromEntries(leaving.map((id) => [id, before[id]!])),
        entering,
        fade: Object.fromEntries((fadingIn ? entering : leaving).map((id) => [id, fade])),
        slide: starting(slide, shiftAt(shift, sw.axis === "x")),
        shift,
        horizontal: sw.axis === "x",
      });
    } else if (pane) {
      setPane(null);
    }
  }
  // Right after the commit: the values start where its first-frame styles put the panes, and play from there.
  useLayoutEffect(() => {
    if (!pane) return;
    if (pane.settled) {
      const timer = setTimeout(() => setPane(null), SETTLE_MS);
      return () => clearTimeout(timer);
    }
    const settle = () => {
      const fadedOff = Object.keys(pane.fade).filter((id) => pane.leaving[id]);
      setPane(fadedOff.length ? { ...pane, leaving: {}, entering: [], fade: Object.fromEntries(fadedOff.map((id) => [id, GONE])), settled: true } : null);
    };
    progress.set(0);
    distance.set(pane.shift);
    horizontal.set(pane.horizontal);
    progress.set(
      withTiming(1, { duration: PAGE_MS, easing: SWITCH_EASING }, (finished) => {
        if (finished) runOnJS(settle)();
      }),
    );
    return () => cancelAnimation(progress);
  }, [pane]);
  return pane;
}

export type SlideOptions = {
  // Where a thing coming on starts, in points along the switch's direction; one going off ends as far the other way.
  offset: number;
  duration: number;
  // The axis to slide on; the switch's own (the strip's, or the sidebar's) by default.
  axis?: Axis;
};

/**
 * The style of something shown for `tabIds` while `on` turns, when a tab switch turned it; null at rest. Mounting on
 * for the tab just switched to counts as turning on.
 */
export function useSwitchSlide(windowId: string, tabIds: string[], on: boolean, options: SlideOptions): SwitchStyle | null {
  // Not memoized by the compiler: which switch this is depends on when the render runs, not only on its arguments.
  "use no memo";
  const progress = useSharedValue(1);
  const coming = useSharedValue(true);
  const distance = useSharedValue(0);
  const horizontal = useSharedValue(false);
  const style = useAnimatedStyle(() => {
    const p = progress.get();
    const d = distance.get();
    return coming.get()
      ? { opacity: p, ...shiftStyle(p, d, 0, horizontal.get()) }
      : { opacity: 1 - p, ...shiftStyle(p, 0, -d, horizontal.get()) };
  });
  const [was, setWas] = useState(() => on && !recentSwitch(windowId, "to", tabIds));
  // The slide playing: its first frame (in the commit that turns it) and where it goes from there.
  const [play, setPlay] = useState<{ first: ViewStyle; on: boolean; distance: number; horizontal: boolean } | null>(null);
  // Decided in the render that turns it, so the first frame drawn is already the slide's.
  if (on !== was) {
    setWas(on);
    const sw = recentSwitch(windowId, on ? "to" : "from", tabIds);
    // After a close the closed row fades out with its fill: the next one shows its own at once, or for a few frames
    // the list had none.
    if (sw && !sw.closed) {
      const distance = reduceMotion() ? 0 : options.offset * sw.direction;
      const horizontal = (options.axis ?? sw.axis) === "x";
      const first = on ? { opacity: 0, ...shiftAt(distance, horizontal) } : { opacity: 1, ...shiftAt(0, horizontal) };
      setPlay({ first, on, distance, horizontal });
    } else if (play) setPlay(null);
  }
  useLayoutEffect(() => {
    if (!play) return;
    const stop = () => setPlay(null);
    progress.set(0);
    coming.set(play.on);
    distance.set(play.distance);
    horizontal.set(play.horizontal);
    progress.set(
      withTiming(1, { duration: options.duration, easing: SWITCH_EASING }, (finished) => {
        if (finished) runOnJS(stop)();
      }),
    );
    return () => cancelAnimation(progress);
  }, [play]);
  return play ? starting(style, play.first) : null;
}
