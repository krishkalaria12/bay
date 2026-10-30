import type { SwipeEvent } from "@bay/nncore";

export type SpaceSwipeGestureProps = {
  canSwipeBack: boolean;
  canSwipeForward: boolean;
  onSwipe: (event: SwipeEvent) => void;
};

const WHEEL_DISTANCE = 48;
const TOUCH_DISTANCE = 48;
const HORIZONTAL_BIAS = 1.25;

function editing(target: EventTarget | null): boolean {
  const node = target as Element | null;
  return typeof node?.closest === "function" && !!node.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]");
}

/** Scoped to a sidebar/strip, never the document or the embedded web page. */
export function bindSpaceGestures(element: HTMLElement, props: () => SpaceSwipeGestureProps, now = Date.now): () => void {
  let touch: { id: number; x: number; y: number; horizontal: boolean } | null = null;
  let suppressClickUntil = 0;
  const direction = (dx: number) => (dx < 0 ? "back" : "forward");
  const available = (dx: number) => (dx < 0 ? props().canSwipeBack : props().canSwipeForward);
  const emit = (phase: SwipeEvent["phase"], dx: number, dy: number, distance: number) => {
    props().onSwipe({ phase, direction: direction(dx), distance, dy, velocity: 0, available: true, width: element.getBoundingClientRect().width });
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || editing(event.target)) return;
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
    if (!dx || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS || !available(dx)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    event.preventDefault();
    emit("wheel", dx, dy, (Math.abs(dx) * unit) / WHEEL_DISTANCE);
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    if (!event.isPrimary || editing(event.target)) {
      touch = null;
      return;
    }
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
  };
  const move = (event: PointerEvent) => {
    if (!touch || touch.id !== event.pointerId) return;
    const dx = touch.x - event.clientX;
    const dy = touch.y - event.clientY;
    if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
      touch = null;
      return;
    }
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS && available(dx)) {
      touch.horizontal = true;
      event.preventDefault();
    }
  };
  const up = (event: PointerEvent) => {
    const start = touch;
    touch = null;
    if (!start || start.id !== event.pointerId || !start.horizontal) return;
    const dx = start.x - event.clientX;
    const dy = start.y - event.clientY;
    if (Math.abs(dx) < TOUCH_DISTANCE || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS || !available(dx)) return;
    suppressClickUntil = now() + 350;
    event.preventDefault();
    event.stopPropagation();
    emit("swipe", dx, dy, Math.abs(dx));
  };
  const cancel = () => {
    touch = null;
  };
  const click = (event: MouseEvent) => {
    if (now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = "pan-y";
  element.addEventListener("wheel", wheel, { passive: false });
  element.addEventListener("pointerdown", down, true);
  element.addEventListener("pointermove", move, { capture: true, passive: false });
  element.addEventListener("pointerup", up, true);
  element.addEventListener("pointercancel", cancel, true);
  element.addEventListener("click", click, true);
  return () => {
    element.style.touchAction = previousTouchAction;
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("pointerdown", down, true);
    element.removeEventListener("pointermove", move, true);
    element.removeEventListener("pointerup", up, true);
    element.removeEventListener("pointercancel", cancel, true);
    element.removeEventListener("click", click, true);
  };
}
