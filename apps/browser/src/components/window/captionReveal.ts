import { onWindowEvent } from "@bay/desktop";
import { useEffect, useState } from "react";

// As Zen's: a moment at the window's top before the bar opens, so passing by doesn't open it, and a little longer
// before it closes, so a pointer that slips off doesn't drop the page back under it.
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 350;

/** Whether the window's hidden caption bar shows: its frame reports the pointer in the band the caption names
 *  (`reveal`), as Chromium sends the UI no mouse events over drag regions. */
export function useCaptionRevealed(windowId: string, enabled: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = onWindowEvent((event) => {
      if (event.type !== "caption" || event.id !== windowId) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRevealed(event.revealed), event.revealed ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      events.remove();
    };
  }, [windowId, enabled]);
  return enabled && revealed;
}
