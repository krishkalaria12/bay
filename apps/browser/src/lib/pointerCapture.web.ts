// A main frame doesn't capture the mouse when pressed (Blink leaves that to subframes), so Chrome sends a drag that
// passes over a page's surface to that page, and the window never hears the rest of it. Capturing the held pointer
// makes Blink ask Chrome to keep it here until the button comes up.

let held: number | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.isPrimary && event.button === 0) held = event.pointerId;
    },
    true,
  );

  const release = (event: PointerEvent) => {
    if (event.pointerId === held) held = null;
  };

  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
}

/** Keeps the pressed pointer's events in this window until it's released: call it as a drag begins. */
export function captureHeldPointer(): void {
  if (held === null) return;

  try {
    // The root, as the element pressed may leave the tree mid-drag (a tab lifted from its list).
    document.documentElement.setPointerCapture(held);
  } catch {
    // The pointer was released between the press and the drag.
  }
}
