import { reportBrowserCommand } from "../../runtime/commands";
import { closePeek } from "../../runtime/splitActions";

// Closing a peek by hand (its Close button, a click on the dimmed page, Esc, ⌘W) plays its card back into the link
// first (PeekLayer.tsx); a window with no peek on screen closes it at once. Closes the store makes itself (keeping it,
// its opener going) stay instant.

const dismissers = new Map<string, () => void>();

export function dismissPeek(windowId: string) {
  const dismiss = dismissers.get(windowId);
  if (dismiss) dismiss();
  else reportBrowserCommand(closePeek(windowId));
}

/** The window's peek on screen takes its dismissals, until the returned function is called. */
export function takePeekDismissal(windowId: string, dismiss: () => void) {
  dismissers.set(windowId, dismiss);
  return () => {
    if (dismissers.get(windowId) === dismiss) dismissers.delete(windowId);
  };
}
