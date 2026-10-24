import { isDarkAppearance, onAppEvent } from "@bay/shell";

// Query replies and appearance events can arrive on different native pipes.
// Once an event arrives, it takes precedence over the bootstrap query.
export function startAppearanceSync(apply: (dark: boolean) => void): () => void {
  let disposed = false;
  let receivedEvent = false;
  const events = onAppEvent((event) => {
    if (disposed || event.type !== "appearance") return;
    receivedEvent = true;
    apply(event.dark);
  });
  void isDarkAppearance().then((dark) => {
    if (!disposed && !receivedEvent) apply(dark);
  });
  return () => {
    disposed = true;
    events.remove();
  };
}
