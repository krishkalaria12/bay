// Files dragged out of the Chrome-hosted desktop to other apps. A page can't start a file drag of its own: a web drag
// carries a URL, not the file. So the gesture is seen here, and the host starts the drag with the real file
// (native_file_drag.cc) while the button is still down.

const THRESHOLD = 4;

export type FileDragSource = { path: string; relative: string | null };

/** A file: URL as the path it names; a path as it is. */
export function fileDragPath(path: string, windows = /^file:\/\/\/[a-z]:/i.test(path)): string {
  if (!path.startsWith("file:")) return path;
  const name = decodeURIComponent(new URL(path).pathname);
  return windows ? name.slice(1).replace(/\//g, "\\") : name;
}

/** Starts `drag` when a left press on `element` moves away. `source` is read at the press: null is nothing to drag. */
export function watchFileDrag(element: HTMLElement, source: () => FileDragSource | null, drag: (file: FileDragSource) => void) {
  const document = element.ownerDocument;
  // A press that became a drag isn't a click, should the button come up here after a drag that didn't start.
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const press = (down: PointerEvent) => {
    element.removeEventListener("click", swallow, true);
    const file = down.button === 0 && !down.ctrlKey ? source() : null;
    if (!file) return;
    const stop = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
    };
    const move = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) <= THRESHOLD) return;
      stop();
      // React Native Web ends a press on a dragstart: the system drag takes the mouse-up, so it would stay pressed.
      element.dispatchEvent(new Event("dragstart", { bubbles: true }));
      element.addEventListener("click", swallow, { capture: true, once: true });
      drag(file);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
  };
  element.addEventListener("pointerdown", press);
  return () => {
    element.removeEventListener("pointerdown", press);
    element.removeEventListener("click", swallow, true);
  };
}
