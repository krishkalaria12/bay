import { onWindowEvent, windowState, type WindowState } from "@bay/shell";

/** State events take precedence over the bootstrap reply, which travels on a separate native pipe. */
export function startCaptionStateSync(windowId: string, apply: (state: WindowState) => void): () => void {
  let disposed = false;
  let receivedEvent = false;
  const events = onWindowEvent((event) => {
    if (disposed || event.type !== "state" || event.id !== windowId) return;
    receivedEvent = true;
    apply({ maximized: event.maximized, fullscreen: event.fullscreen });
  });
  void windowState(windowId).then(
    (state) => {
      if (!disposed && !receivedEvent) apply(state);
    },
    () => {},
  );
  return () => {
    disposed = true;
    events.remove();
  };
}
