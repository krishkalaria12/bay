import { useEffect, useRef } from "react";

type PointerEvent = { nativeEvent: { pageX: number; pageY: number } };

// Hover selects a row only when the pointer moves onto it. Rows that slide under a still pointer as the list
// changes (typing, filtering) fire mouseenter too, and would otherwise take the keyboard's selection.
export function usePointerHover(list: unknown) {
  const pointer = useRef({ x: NaN, y: NaN });
  const changed = useRef(true);
  useEffect(() => {
    changed.current = true;
  }, [list]);
  return (event: PointerEvent, select: () => void) => {
    const { pageX: x, pageY: y } = event.nativeEvent;
    const moved = Math.abs(x - pointer.current.x) >= 1 || Math.abs(y - pointer.current.y) >= 1;
    pointer.current = { x, y };
    if (changed.current) {
      changed.current = false;
      return;
    }
    if (moved) select();
  };
}
