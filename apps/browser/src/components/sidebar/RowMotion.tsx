import { FadeLabel } from "@bay/shell";
import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { reduceMotion } from "../../lib/reduceMotion";
import { useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { activeTabId } from "../../store/model";
import type { Tab } from "../../store/types";
import { tabTitle } from "./actions";
import { SelectedFill } from "./ActiveHighlight";
import { useDragSource } from "./dnd";
import { TabIcon } from "./TabIcon";
import { MAX_MOVING_ROWS, ROW_FRESH_MS, ROW_MS } from "./constants";

// As yab opens and closes tabs: a new tab's row fades in where it goes as the rows under it make room, and a closed
// one's fades where it was as they close the gap. Eased in and out: the switch's curve, half done in its first frame,
// shut a closing row at once.
const ROW_EASING = Easing.inOut(Easing.cubic);

export type ClosingTab = { tab: Tab; active: boolean };

// Tabs just closed, as they were: their rows are gone from the store by the time the list renders without them.
const closed = new Map<string, ClosingTab & { at: number }>();

useBrowser.subscribe((s, prev) => {
  if (s.tabLists === prev.tabLists) return;
  const now = Date.now();
  for (const [key, was] of Object.entries(prev.tabLists)) {
    if (s.tabLists[key] === was) continue;
    for (const id of was) {
      const tab = prev.tabs[id];
      if (s.tabs[id] || !tab) continue;
      closed.set(id, { tab, active: Object.keys(prev.windows).some((w) => activeTabId(prev, w) === id), at: now });
    }
  }
  for (const [id, c] of closed) if (now - c.at > ROW_FRESH_MS) closed.delete(id);
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
    const fresh = entries.filter((e) => !had.has(e) && e.startsWith("t:") && now - (tabs[e.slice(2)]?.createdAt ?? 0) <= ROW_FRESH_MS);
    const stillOpening = [...opening].filter((e) => listed.has(e));
    const nextOpening = animate && fresh.length <= MAX_MOVING_ROWS ? [...stillOpening, ...fresh] : stillOpening;
    if (nextOpening.length !== opening.size || nextOpening.some((e) => !opening.has(e))) setOpening(nextOpening.length ? new Set(nextOpening) : NONE);

    const gone: Ghost[] = [];
    before.forEach((entry, i) => {
      const closing = !listed.has(entry) && entry.startsWith("t:") ? closed.get(entry.slice(2)) : undefined;
      if (!closing || now - closing.at > ROW_FRESH_MS) return;
      // Placed after the nearest entry above it that stays (null: the top of the list).
      let after: string | null = null;
      for (let k = i - 1; k >= 0 && after === null; k--) if (listed.has(before[k]!)) after = before[k]!;
      gone.push({ tab: closing.tab, active: closing.active, after });
    });
    // A row whose place went too can't stay; one placed at the top stays there.
    const staying = ghosts.filter((g) => g.after === null || listed.has(g.after));
    const next = animate && gone.length <= MAX_MOVING_ROWS ? [...staying, ...gone] : staying;
    if (next.length !== ghosts.length || next.some((g, i) => g !== ghosts[i])) setGhosts(next);
  }
  // Made once: every row gets them, and a new function would re-render them all.
  const [gone] = useState(() => (tabId: string) => setGhosts((all) => all.filter((g) => g.tab.id !== tabId)));
  const [opened] = useState(
    () => (entry: string) =>
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

// The heights move the rows under them with the layout, from the UI thread.
const play = (onDone: () => void) =>
  withTiming(1, { duration: ROW_MS, easing: ROW_EASING }, () => {
    runOnJS(onDone)();
  });

/** Wraps a list entry: while its tab has just opened, it grows from nothing (its gap included) and fades in. */
export function OpeningRow({
  entry,
  opening,
  onOpened,
  children,
}: {
  entry: string;
  opening: boolean;
  onOpened: (entry: string) => void;
  children: ReactNode;
}) {
  const [grows] = useState(opening);
  const progress = useSharedValue(grows ? 0 : 1);
  useEffect(() => {
    if (grows) progress.set(play(() => onOpened(entry)));
  }, []);
  const growing = grows && opening;
  // Every value, "auto" at rest: a value the style stops giving keeps the last one it gave.
  const style = useAnimatedStyle(() => {
    const p = growing ? progress.get() : 1;
    return {
      height: growing ? p * layout.rowHeight : "auto",
      marginBottom: (p - 1) * layout.rowGap,
      opacity: interpolate(p, [0.25, 1], [0, 1], Extrapolation.CLAMP),
      overflow: growing ? "hidden" : "visible",
    };
  }, [growing]);
  // Dragged, its entry closes up inside this wrapper: the wrapper takes back the list's gap after it, or the rows
  // below moved down by it as a drag began.
  const dragged = useDragSource(entry);
  return <Animated.View style={[style, dragged ? { marginBottom: -layout.rowGap } : null]}>{children}</Animated.View>;
}

/** A closed tab's row on its way out: it fades, and its room (its gap included) closes. */
export function ClosingTabRow({ row, onGone }: { row: ClosingTab; onGone: (tabId: string) => void }) {
  const theme = useTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(play(() => onGone(row.tab.id)));
  }, []);
  const style = useAnimatedStyle(() => {
    const p = progress.get();
    return { height: (1 - p) * layout.rowHeight, marginBottom: -p * layout.rowGap, opacity: interpolate(p, [0, 0.75], [1, 0], Extrapolation.CLAMP) };
  });
  const { tab, active } = row;
  return (
    <Animated.View pointerEvents="none" style={[{ overflow: "hidden" }, style]}>
      <View style={{ height: layout.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 9, paddingRight: 6 }}>
        {active && <SelectedFill borderWidth={0.5} />}
        <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} spaceId={tab.spaceId} />
        <FadeLabel text={tabTitle(tab)} fontSize={13} color={active ? theme.tabSelectedText : theme.textTab} style={{ flex: 1, height: 18, marginLeft: 5 }} />
      </View>
    </Animated.View>
  );
}
