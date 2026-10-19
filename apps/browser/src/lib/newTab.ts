import { dispatchBrowserCommand } from "../runtime/commands";

/** User-facing New Tab requests keep the current page underneath the palette. */
export function openNewTabPanel(windowId: string, groupId?: string): Promise<null> {
  return dispatchBrowserCommand({ method: "requestNewTab", windowId, ...(groupId ? { groupId } : {}) });
}
