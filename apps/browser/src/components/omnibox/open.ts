import { modKey } from "@bay/platform";
import { switchToTab } from "../../lib/actions";
import { dispatchBrowserCommand } from "../../runtime/commands";
import { useBrowser } from "../../store/browser";

export type Disposition = "current" | "newTab" | "newWindow";

export function dispositionFor(mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): Disposition {
  if (modKey(mods) || mods.altKey) return "newTab";
  if (mods.shiftKey) return "newWindow";
  return "current";
}

export function openFromBar(url: string, tabId: string, disposition: Disposition): Promise<null> {
  return dispatchBrowserCommand({ method: "openLocation", sourceTabId: tabId, url, disposition });
}

export function openInBackground(url: string, barTabId: string): Promise<null> {
  return dispatchBrowserCommand({ method: "openLocation", sourceTabId: barTabId, url, disposition: "backgroundTab" });
}

export function switchFromBar(targetTabId: string, url: string, barTabId: string, disposition: Disposition): Promise<null> {
  return disposition === "current"
    ? dispatchBrowserCommand({ method: "switchToExistingTab", sourceTabId: barTabId, targetTabId })
    : openFromBar(url, barTabId, disposition);
}

// A cleaned up tab goes back where it was, in its space, and the bar switches to it; false if it's no longer there.
export function restoreFromBar(entryId: string, barTabId: string): boolean {
  const s = useBrowser.getState();
  const bar = s.tabs[barTabId];
  const restored = s.restoreCleaned(entryId, bar?.windowId);
  if (!restored) return false;
  if (bar) s.closePanel(bar.windowId);
  switchToTab(restored);
  return true;
}
