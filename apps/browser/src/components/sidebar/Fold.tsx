import { View } from "@bay/platform";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "@bay/platform/motion";
import type { LayoutChangeEvent } from "react-native";
import { FOLD_MS } from "./constants";

// Dia 1.50.1 (owner recording, 60 fps): a group opens or closes in FOLD_MS, fast at first.
const FOLD_EASING = Easing.bezier(0.2, 0.9, 0.3, 1);

export type FoldState = { open: SharedValue<number>; moving: boolean };

/** `open` runs to 0 (collapsed) or 1; `moving` until the latest change has finished (an interrupted one never settles). */
export function useFold(collapsed: boolean): FoldState {
  const open = useSharedValue(collapsed ? 0 : 1);
  const [settled, setSettled] = useState(collapsed);
  const [running, setRunning] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setRunning(true);
    // A height: it reflows the rows below.
    const settle = () => {
      setSettled(collapsed);
      setRunning(false);
    };
    open.set(
      withTiming(collapsed ? 0 : 1, { duration: FOLD_MS, easing: FOLD_EASING }, (finished) => {
        if (finished) runOnJS(settle)();
      }),
    );
    return () => cancelAnimation(open);
  }, [collapsed]);
  return { open, moving: running || settled !== collapsed };
}

export type FoldEntry = { key: string; node: ReactNode; height?: number };

/**
 * The members of a sidebar group or live folder, opening and closing on `fold`. Closed, the block shows nothing, or
 * only `keep` (the window's active tab): then the block folds around it, every other entry sliding away or back while
 * it stays put at full opacity. Every entry has one wrapper in every state, so the kept row never remounts or pops.
 * `rowHeight`: every entry's height, known before layout (entries closed and settled aren't mounted, unless
 * `mountClosed`); without it each entry is measured and stays mounted. `footer` must take no room (a drag tail).
 */
export function Fold({
  fold,
  collapsed,
  entries,
  keep,
  gap,
  rowHeight,
  padTop = 0,
  padBottom = 0,
  mountClosed = false,
  footer,
}: {
  fold: FoldState;
  collapsed: boolean;
  entries: FoldEntry[];
  keep?: string | null;
  gap: number;
  rowHeight?: number;
  padTop?: number;
  padBottom?: number;
  mountClosed?: boolean;
  footer?: ReactNode;
}) {
  const { open, moving } = fold;
  const measuring = rowHeight === undefined && entries.some((e) => e.height === undefined);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const kept = keep && entries.some((e) => e.key === keep) ? keep : null;
  const folding = !!kept && (collapsed || moving);
  const heightOf = (key: string) => entries.find((e) => e.key === key)?.height ?? rowHeight ?? measured[key] ?? 0;
  const total = entries.reduce((sum, e) => sum + heightOf(e.key), 0) + gap * Math.max(0, entries.length - 1) + padTop + padBottom;
  // The block: its own height while folding around a kept entry (the entries fold instead) or open, else from
  // nothing to all of it.
  const outerMode: FoldMode = folding || (!moving && !collapsed) ? "free" : moving ? "moving" : "closed";
  const outer = useFoldStyle(open, outerMode, total, 0);
  const mountAll = !collapsed || moving || mountClosed || measuring;

  return (
    <Animated.View style={outer} pointerEvents={collapsed ? "box-none" : "auto"}>
      {/* Measured entries lay out at their own height while the block is closed: a view in a clipped, zero-height
          parent reports a height of 0. */}
      <View
        style={[
          { gap, paddingTop: padTop, paddingBottom: padBottom },
          measuring && outerMode === "closed" ? { position: "absolute", left: 0, right: 0, top: 0 } : null,
        ]}
      >
        {entries.map(({ key, node }) => {
          const stays = key === kept;
          if (!stays && !mountAll) return null;
          return (
            <FoldItem
              key={key}
              open={open}
              mode={folding && !stays ? (moving ? "moving" : "closed") : "free"}
              height={heightOf(key)}
              gap={gap}
              pointerEvents={collapsed && !stays ? "none" : "auto"}
            >
              {measuring ? (
                <View
                  onLayout={(e) => {
                    // A folded entry's wrapper squeezes it: only a free one tells its height.
                    if (moving || (folding && key !== kept)) return;
                    const height = e.nativeEvent.layout.height;
                    setMeasured((all) => (all[key] === height ? all : { ...all, [key]: height }));
                  }}
                >
                  {node}
                </View>
              ) : (
                node
              )}
            </FoldItem>
          );
        })}
        {footer}
      </View>
    </Animated.View>
  );
}

/**
 * A block that folds away whole (a space's pinned sections): its height measured, unmounted once closed. Moving, the
 * content lays out on its own, so it tells its height even opening for the first time.
 */
export function FoldAway({ collapsed, onLayout, children }: { collapsed: boolean; onLayout?: (e: LayoutChangeEvent) => void; children: ReactNode }) {
  const fold = useFold(collapsed);
  const [height, setHeight] = useState(0);
  const mode: FoldMode = fold.moving ? "moving" : collapsed ? "closed" : "free";
  const style = useFoldStyle(fold.open, mode, height, 0);
  if (mode === "closed") return null;
  return (
    <Animated.View style={style} onLayout={onLayout} pointerEvents={collapsed ? "none" : "auto"}>
      <View style={mode === "moving" ? { position: "absolute", left: 0, right: 0, top: 0 } : null} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
        {children}
      </View>
    </Animated.View>
  );
}

// free: its own height; moving: `open` of `height` (and the gap after it closing with it); closed: nothing.
type FoldMode = "free" | "moving" | "closed";

// Every value in every mode, "auto" when free: a value the style stops giving keeps the last one it gave.
function useFoldStyle(open: SharedValue<number>, mode: FoldMode, height: number, gap: number) {
  return useAnimatedStyle(() => {
    let o = open.get();
    if (mode === "free") o = 1;
    else if (mode === "closed") o = 0;
    return {
      height: mode === "free" ? "auto" : o * height,
      marginBottom: (o - 1) * gap,
      opacity: o,
      overflow: mode === "free" ? "visible" : "hidden",
    };
  }, [mode, height, gap]);
}

// An entry, folding with the block: shrinking to nothing, the gap after it cancelled.
function FoldItem({
  open,
  mode,
  height,
  gap,
  pointerEvents,
  children,
}: {
  open: SharedValue<number>;
  mode: FoldMode;
  height: number;
  gap: number;
  pointerEvents: "none" | "auto";
  children: ReactNode;
}) {
  const style = useFoldStyle(open, mode, height, gap);
  return (
    <Animated.View style={style} pointerEvents={pointerEvents}>
      {children}
    </Animated.View>
  );
}
