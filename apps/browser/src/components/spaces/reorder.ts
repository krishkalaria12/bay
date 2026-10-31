import { hapticTick } from "@bay/shell";
import { useLayoutEffect, useState } from "react";
import { PanResponder } from "react-native";
import { Easing, makeMutable, withTiming, type SharedValue } from "@bay/platform/motion";
import { useBrowserRead as useBrowser } from "../../store/read";
import { reportBrowserCommand } from "../../runtime/commands";
import { reorderSpaces } from "../../runtime/spaceActions";

// Arc's space reordering: drag a space along its list (the sidebar's icons or dots, the settings rows), the spaces it
// passes make room, and let go, the store reorders them.

export type SpaceReorder = ReturnType<typeof spaceReorder>;

// How far past either end the dragged space follows the pointer.
const OVERSHOOT = 6;

const settle = (value: SharedValue<number>, toValue: number) => value.set(withTiming(toValue, { duration: 160, easing: Easing.out(Easing.cubic) }));

/** `step`: how far apart the spaces are along the list. */
function spaceReorder(step: number, setDragging: (id: string | null) => void) {
  const offsets = new Map<string, SharedValue<number>>();
  let drag = { id: "", from: 0, to: 0, reorderPending: false };
  const offsetOf = (id: string) => {
    let v = offsets.get(id);
    if (!v) offsets.set(id, (v = makeMutable(0)));
    return v;
  };
  return {
    offsetOf,
    // The store has the new order: the spaces are laid out where they were dragged to.
    reordered() {
      if (!drag.reorderPending) return;
      drag.reorderPending = false;
      offsets.forEach((v) => v.set(0));
    },
    start(id: string) {
      const from = useBrowser.getState().spaceOrder.indexOf(id);
      drag = { id, from, to: from, reorderPending: false };
      setDragging(id);
    },
    move(delta: number) {
      const { id, from } = drag;
      const ids = useBrowser.getState().spaceOrder;
      const max = ids.length - 1;
      offsetOf(id).set(Math.max(-from * step - OVERSHOOT, Math.min((max - from) * step + OVERSHOOT, delta)));
      const to = Math.max(0, Math.min(max, Math.round(from + delta / step)));
      if (to === drag.to) return;
      drag.to = to;
      hapticTick();
      // The spaces between where it was and where it is make room on the side it left.
      const shift = (j: number) => {
        if (from < j && j <= to) return -step;
        if (to <= j && j < from) return step;
        return 0;
      };
      ids.forEach((other, j) => {
        if (other !== id) settle(offsetOf(other), shift(j));
      });
    },
    end(commit: boolean) {
      const { id, from, to } = drag;
      setDragging(null);
      if (!commit || from === to) {
        offsets.forEach((v) => settle(v, 0));
        return;
      }
      const ids = useBrowser.getState().spaceOrder.filter((x) => x !== id);
      ids.splice(to, 0, id);
      drag.reorderPending = true;
      reportBrowserCommand(reorderSpaces(ids));
    },
  };
}

/** A list of spaces' reordering, and the space being dragged. */
export function useSpaceReorder(step: number) {
  const order = useBrowser((s) => s.spaceOrder);
  const [dragging, setDragging] = useState<string | null>(null);
  const [reorder] = useState(() => spaceReorder(step, setDragging));
  useLayoutEffect(() => reorder.reordered(), [order, reorder]);
  return { reorder, dragging };
}

/** A space's drag handlers: a move past a few points takes it from a press inside, and drags it along `axis`. */
export function useSpaceDrag(reorder: SpaceReorder, id: string, axis: "x" | "y") {
  const [pan] = useState(() => {
    const along = (g: { dx: number; dy: number }) => (axis === "x" ? g.dx : g.dy);
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(along(g)) > 3,
      onPanResponderGrant: () => reorder.start(id),
      onPanResponderMove: (_, g) => reorder.move(along(g)),
      onPanResponderRelease: () => reorder.end(true),
      onPanResponderTerminate: () => reorder.end(false),
      onPanResponderTerminationRequest: () => false,
    });
  });
  return pan.panHandlers;
}
