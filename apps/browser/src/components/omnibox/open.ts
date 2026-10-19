import { modKey } from "@bay/platform";
import { dispatchBrowserCommand } from "../../runtime/commands";

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
