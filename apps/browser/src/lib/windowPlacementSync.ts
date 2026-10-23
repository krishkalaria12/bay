import { capabilities } from "@bay/platform";
import { onWindowEvent, windowState, type WindowState } from "@bay/shell";
import type { BrowserStore } from "../store/browser";
import { validWindowSize } from "../store/windowPlacement";

/** Subscribe before opening/querying. A native event wins over the bootstrap reply. */
export function startWindowPlacementSync(store: BrowserStore) {
  let disposed = false;
  const seen = new Set<string>();
  const pending = new Map<string, object>();
  const apply = (id: string, state: WindowState) => {
    if (!state || typeof state.maximized !== "boolean" || typeof state.fullscreen !== "boolean") return;
    // Native maximized is false during fullscreen/minimized. Keep the last restorable placement.
    if (state.fullscreen || state.minimized) return;
    if (state.size !== undefined && !validWindowSize(state.size)) return;
    store.getState().setWindowPlacement(id, { size: state.size, maximized: state.maximized });
  };
  const events = onWindowEvent((event) => {
    if (disposed || capabilities.globalWindowCoordinates) return;
    if (event.type === "close") {
      seen.delete(event.id);
      pending.delete(event.id);
    }
    if (event.type !== "state" || !store.getState().windows[event.id]) return;
    seen.add(event.id);
    pending.delete(event.id);
    apply(event.id, event);
  });
  const stop = store.subscribe((state, previous) => {
    if (state.windows === previous.windows) return;
    for (const id of Object.keys(previous.windows)) {
      if (state.windows[id]) continue;
      seen.delete(id);
      pending.delete(id);
    }
  });
  return {
    /** Call only after native open acknowledges the window, in either authority mode. */
    opened(id: string) {
      if (disposed || capabilities.globalWindowCoordinates || seen.has(id) || !store.getState().windows[id]) return;
      const token = {};
      pending.set(id, token);
      void windowState(id).then(
        (state) => {
          if (disposed || pending.get(id) !== token) return;
          pending.delete(id);
          if (store.getState().windows[id]) apply(id, state);
        },
        () => {
          if (pending.get(id) === token) pending.delete(id);
        },
      );
    },
    dispose() {
      disposed = true;
      pending.clear();
      seen.clear();
      stop();
      events.remove();
    },
  };
}
