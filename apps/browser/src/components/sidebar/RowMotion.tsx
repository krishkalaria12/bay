import { FadeLabel } from "@bay/shell";
import { useEffect, useState, type ReactNode } from "react";
import { Animated, Easing, View } from "react-native";
import { reduceMotion } from "../../lib/reduceMotion";
import { layout, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { activeTabId } from "../../store/model";
import type { Tab } from "../../store/types";
import { tabTitle } from "./actions";
import { SelectedFill } from "./ActiveHighlight";
import { TabIcon } from "./TabIcon";

// As yab opens and closes tabs: a new tab's row fades in where it goes as the rows under it make room, and a closed
// one's fades where it was as they close the gap. Eased in and out: the switch's curve, half done in its first frame,
// shut a closing row at once.
const ROW_MS = 180;
const ROW_EASING = Easing.inOut(Easing.cubic);
// Opening or closing more at once (restoring a window, cleaning up) just shows the list as it is.
const MAX_MOVING = 3;
const FRESH_MS = 500;

export type ClosingTab = { tab: Tab; active: boolean };

// Tabs just closed, as they were: their rows are gone from the store by the time the list renders without them.
const closed = new Map<string, ClosingTab & { at: number }>();

useBrowser.subscribe((s, prev) => {
  if (s.windows === prev.windows) return;
  const now = Date.now();
  for (const [windowId, was] of Object.entries(prev.windows)) {
    const tabIds = s.windows[windowId]?.tabIds;
    if (tabIds === was.tabIds) continue;
    const kept = new Set(tabIds);
    for (const id of was.tabIds) {
      const tab = prev.tabs[id];
      if (!kept.has(id) && !s.tabs[id] && tab) closed.set(id, { tab, active: activeTabId(prev, windowId) === id, at: now });
    }
  }
  for (const [id, c] of closed) if (now - c.at > FRESH_MS) closed.delete(id);
});

type Ghost = ClosingTab & { after: string | null };

export type RowMotion = {
  // The list's entries, with the rows of tabs just closed kept in their place while they go.
  rows: (string | ClosingTab)[];
  // Entries of tabs just opened, growing in.
  opening: ReadonlySet<string>;
  // What a row calls once it's gone, or in.
  gone: (tabId: string) => void;
  opened: (entry: string) => void;
};

const NONE = new Set<string>();

/** Rows coming and going in the list as tabs open and close. */
export function useRowMotion(entries: string[], enabled: boolean): RowMotion {
  // Not memoized by the compiler: which tabs just opened or closed depends on when the render runs, not only on its
  // arguments.
  "use no memo";
  const [before, setBefore] = useState(entries);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [opening, setOpening] = useState<ReadonlySet<string>>(NONE);
  // Decided in the render that changes the rows, so no frame shows the list closed up (or the new row whole) first.
  if (entries !== before) {
    setBefore(entries);
    const listed = new Set(entries);
    const had = new Set(before);
    const now = Date.now();
    const animate = enabled && !reduceMotion();

    const tabs = useBrowser.getState().tabs;
    const fresh = entries.filter((e) => !had.has(e) && e.startsWith("t:") && now - (tabs[e.slice(2)]?.createdAt ?? 0) <= FRESH_MS);
    const stillOpening = [...opening].filter((e) => listed.has(e));
    const nextOpening = animate && fresh.length <= MAX_MOVING ? [...stillOpening, ...fresh] : stillOpening;
    if (nextOpening.length !== opening.size || nextOpening.some((e) => !opening.has(e))) setOpening(nextOpening.length ? new Set(nextOpening) : NONE);

    const gone: Ghost[] = [];
    before.forEach((entry, i) => {
      const closing = !listed.has(entry) && entry.startsWith("t:") ? closed.get(entry.slice(2)) : undefined;
      if (!closing || now - closing.at > FRESH_MS) return;
      // Placed after the nearest entry above it that stays (null: the top of the list).
      let after: string | null = null;
      for (let k = i - 1; k >= 0 && after === null; k--) if (listed.has(before[k]!)) after = before[k]!;
      gone.push({ tab: closing.tab, active: closing.active, after });
    });
    // A row whose place went too can't stay; one placed at the top stays there.
    const staying = ghosts.filter((g) => g.after === null || listed.has(g.after));
    const next = animate && gone.length <= MAX_MOVING ? [...staying, ...gone] : staying;
    if (next.length !== ghosts.length || next.some((g, i) => g !== ghosts[i])) setGhosts(next);
  }
  // Made once: every row gets them, and a new function would re-render them all.
  const [gone] = useState(() => (tabId: string) => setGhosts((all) => all.filter((g) => g.tab.id !== tabId)));
  const [opened] = useState(() => (entry: string) =>
    setOpening((all) => {
      if (!all.has(entry)) return all;
      const rest = [...all].filter((e) => e !== entry);
      return rest.length ? new Set(rest) : NONE;
    }),
  );
  if (!ghosts.length) return { rows: entries, opening, gone, opened };
  const rows: (string | ClosingTab)[] = ghosts.filter((g) => g.after === null);
  for (const entry of entries) rows.push(entry, ...ghosts.filter((g) => g.after === entry));
  return { rows, opening, gone, opened };
}

const rowProgress = (progress: Animated.Value, inputRange: number[], outputRange: number[]) =>
  progress.interpolate({ inputRange, outputRange, extrapolate: "clamp" });

/** Wraps a list entry: while its tab has just opened, it grows from nothing (its gap included) and fades in. */
export function OpeningRow({ entry, opening, onOpened, children }: { entry: string; opening: boolean; onOpened: (entry: string) => void; children: ReactNode }) {
  const [progress] = useState(() => (opening ? new Animated.Value(0) : null));
  useEffect(() => {
    if (!progress) return;
    // Height can't be driven natively: the rows under it move with the layout.
    const run = Animated.timing(progress, { toValue: 1, duration: ROW_MS, easing: ROW_EASING, useNativeDriver: false });
    run.start(() => onOpened(entry));
    return () => run.stop();
  }, []);
  const growing = progress && opening;
  return (
    <Animated.View
      style={
        growing
          ? {
              height: rowProgress(progress, [0, 1], [0, layout.rowHeight]),
              marginBottom: rowProgress(progress, [0, 1], [-layout.rowGap, 0]),
              opacity: rowProgress(progress, [0.25, 1], [0, 1]),
              overflow: "hidden",
            }
          : undefined
      }
    >
      {children}
    </Animated.View>
  );
}

/** A closed tab's row on its way out: it fades, and its room (its gap included) closes. */
export function ClosingTabRow({ row, onGone }: { row: ClosingTab; onGone: (tabId: string) => void }) {
  const theme = useTheme();
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    // Height can't be driven natively: the rows under it move with the layout.
    const run = Animated.timing(progress, { toValue: 1, duration: ROW_MS, easing: ROW_EASING, useNativeDriver: false });
    run.start(() => onGone(row.tab.id));
    return () => run.stop();
  }, []);
  const { tab, active } = row;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        height: rowProgress(progress, [0, 1], [layout.rowHeight, 0]),
        marginBottom: rowProgress(progress, [0, 1], [0, -layout.rowGap]),
        opacity: rowProgress(progress, [0, 0.75], [1, 0]),
        overflow: "hidden",
      }}
    >
      <View style={{ height: layout.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 9, paddingRight: 6 }}>
        {active && <SelectedFill borderWidth={0.5} />}
        <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} />
        <FadeLabel text={tabTitle(tab)} fontSize={13} color={active ? theme.tabSelectedText : theme.textTab} style={{ flex: 1, height: 18, marginLeft: 5 }} />
      </View>
    </Animated.View>
  );
}
