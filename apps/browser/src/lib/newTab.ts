import { focusWindow } from "@bay/desktop";
import { useBrowser } from "../store/browserStore";
import { mainWindowFor } from "../store/littleBay";

/** User-facing New Tab requests keep the current page underneath the palette. */
export function openNewTabPanel(windowId: string, groupId?: string) {
  const s = useBrowser.getState();
  const window = s.windows[windowId];

  if (!window) return;
  const main = window.kind === "small" ? mainWindowFor(s, window.spaceId) : windowId;
  const target = main ?? s.createWindow({ spaceId: window.spaceId });

  // A newly created main window already owns its initial blank tab.
  if (main) useBrowser.getState().openNewTabPanel(target, target === windowId ? groupId : undefined);
  else useBrowser.getState().openPanel(target);

  if (target !== windowId) {
    useBrowser.getState().setFocusedWindow(target);
    void focusWindow(target);
  }
}
