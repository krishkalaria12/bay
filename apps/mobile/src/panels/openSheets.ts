import { useSyncExternalStore } from "react";

// How many sheets are open now. A sheet draws in HeroUI's portal, beside the browser rather than over it in the view
// tree, so screen readers would still reach the page and the bar behind it; the browser hides itself from them while
// this is above zero, which makes every sheet modal for VoiceOver and TalkBack.
let open = 0;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

const anyOpen = (): boolean => open > 0;

/** Counts a sheet as open until the returned function is called. */
export function holdSheetOpen(): () => void {
  let held = true;
  open += 1;
  notify();

  return () => {
    if (!held) return;
    held = false;
    open -= 1;
    notify();
  };
}

/** Whether any sheet is open, so the screen behind it can step out of the screen reader's way. */
export function useSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOpen, anyOpen);
}
