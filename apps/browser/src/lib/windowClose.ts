import { confirm, onWindowEvent } from "@bay/shell";
import { browserRead } from "../store/read";
import { closeWindow } from "../runtime/windowActions";
import { reportBrowserCommand } from "../runtime/commands";
import { updateSettings } from "../runtime/settingsActions";
import { inPinnedContainer, listIds, plural, spaceFor, viewTabIds, windowListKey } from "../store/model";
import { CLOSE_WARNING_MIN_TABS } from "./constants";

export function startWindowCloseGuard() {
  const pending = new Set<string>();
  onWindowEvent((e) => {
    if (e.type !== "closeRequest" || pending.has(e.id)) return;
    pending.add(e.id);
    void requestClose(e.id)
      .catch((error) => console.error("Couldn't close the window", error))
      .finally(() => pending.delete(e.id));
  });
}

async function requestClose(windowId: string) {
  const s = browserRead.getState();
  const w = s.windows[windowId];
  if (!w) return;
  // A main window's tabs are its space's: they stay when it closes. A private window's go with it.
  const count = w.incognito ? closingTabs(windowId).length : 0;
  if (s.settings.warnBeforeClosingWindow && count >= CLOSE_WARNING_MIN_TABS) {
    const { confirmed, suppressed } = await confirm({ ...closeWindowDialog(windowId), suppression: "Don’t ask me again", windowId });
    if (suppressed) reportBrowserCommand(updateSettings({ warnBeforeClosingWindow: false }));
    if (!confirmed) return;
  }
  if (browserRead.getState().windows[windowId]) await closeWindow(windowId);
}

// The tabs closing goes with: a private window's, else (its last tab closing) the open ones it shows.
const closingTabs = (windowId: string) => {
  const s = browserRead.getState();
  const w = s.windows[windowId];
  if (!w) return [];
  const ids = w.incognito ? listIds(s, windowListKey(s, w)) : viewTabIds(s, windowId).filter((id) => !s.tabs[id]!.unloaded);
  return ids.filter((id) => !inPinnedContainer(s, id));
};

export function closeWindowDialog(windowId: string) {
  const s = browserRead.getState();
  const w = s.windows[windowId]!;
  const tabs = (n: number) => plural(n, "tab");
  const byProfile = new Map<string, number>();
  const closing = closingTabs(windowId);
  for (const id of closing) {
    const spaceId = s.tabs[id]?.spaceId ?? w.spaceId;
    byProfile.set(spaceId, (byProfile.get(spaceId) ?? 0) + 1);
  }
  const count = closing.length;
  const message =
    byProfile.size > 1
      ? ["Closing this window closes all tabs open across spaces:", ...[...byProfile].map(([id, n]) => `  • ${tabs(n)} in ${spaceFor(s, id).name}`)].join("\n")
      : `This window has ${tabs(count)} open in your ${spaceFor(s, w.spaceId).name} space.`;
  return {
    title: count === 1 ? "Close 1 tab?" : `Close ${count} tabs?`,
    message,
    confirmTitle: count === 1 ? "Close Tab" : "Close All Tabs",
  };
}
