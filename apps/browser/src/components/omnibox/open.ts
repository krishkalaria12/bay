import { modKey } from "@bay/platform";
import { switchToTab } from "../../lib/actions";
import { dispatchBrowserCommand } from "../../runtime/commands";
import { restoreCleaned } from "../../runtime/organizeActions";
import { cleanedTabsFor } from "../../store/organize";
import { browserRead } from "../../store/read";
import { dismissCommandPanel } from "../../runtime/windowUiActions";

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
export async function restoreFromBar(entryId: string, barTabId: string): Promise<boolean> {
  const s = browserRead.getState();
  const bar = s.tabs[barTabId];
  if (!bar || !cleanedTabsFor(s, bar.windowId).some((entry) => entry.id === entryId)) return false;
  const restored = await restoreCleaned(bar.windowId, entryId);
  if (!restored) return false;
  await dismissCommandPanel(bar.windowId);
  await switchToTab(restored);
  return true;
}
