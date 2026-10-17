import { useEffect, useRef } from "react";

export type PointerHoverEvent = { nativeEvent: { screenX: number; screenY: number } };

// Hover selects a row only when the pointer moves onto it. Rows that slide under a still pointer as the list
// changes (typing, filtering) fire mouseenter too, and would otherwise take the keyboard's selection.
export function usePointerHover(list: unknown) {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const changed = useRef(true);
  useEffect(() => {
    changed.current = true;
  }, [list]);
  return (event: PointerHoverEvent, select: () => void) => {
    const { screenX: x, screenY: y } = event.nativeEvent;
    const previous = pointer.current;
    const moved = !previous || Math.abs(x - previous.x) >= 1 || Math.abs(y - previous.y) >= 1;
    pointer.current = { x, y };
    if (changed.current) {
      changed.current = false;
      if (previous) return;
    }
    if (moved) select();
  };
}
