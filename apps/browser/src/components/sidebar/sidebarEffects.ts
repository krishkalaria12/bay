import { onAppEvent } from "@bay/desktop";
import { everySlowly } from "../../lib/throttledTimers";
import { webviews } from "../../lib/webviews";
import { startLive } from "../../activity";
import { useBrowser } from "../../store/browserStore";
import { changedIds } from "../../store/recordDiff";
import { cancelSwitcher, commitSwitcher, moveSwitcher } from "./spaceSwitcher";
import { AUTO_CLEAN_EVERY_MS } from "./constants";
import { startCleanupNotifications } from "./cleanupNotifications";
import { showToast } from "../split/splitActions";

let started = false;

export function startSidebarEffects() {
  if (started) return;
  started = true;
  startLive();
  // Effects start after session hydration, so saved cleaned tabs don't replay a notice.
  startCleanupNotifications((windowId, count) => {
    showToast(windowId, `${count} ${count === 1 ? "tab" : "tabs"} cleaned`, undefined, { icon: "wand.and.stars" });
  });

  useBrowser.subscribe((s, prev) => {
    for (const id of changedIds(s.tabs, prev.tabs)) {
      const muted = s.tabs[id]?.muted;
      if (muted !== undefined && prev.tabs[id] && prev.tabs[id]!.muted !== muted) void webviews.get(id)?.setMuted(muted);
    }
  });

  onAppEvent((e) => {
    if (e.type === "resignActive" || e.type === "screenLocked") useBrowser.getState().closeAbandonedNewTabs();
    if (e.type === "controlReleased" || e.type === "resignActive") commitSwitcher();
    if (e.type === "switcherMouseUp" || (e.type === "switcherKey" && e.key === "escape")) cancelSwitcher();
    if (e.type === "switcherKey" && e.key !== "escape") moveSwitcher(e.key === "next" ? 1 : -1);
  });

  everySlowly({ every: AUTO_CLEAN_EVERY_MS, run: () => useBrowser.getState().cleanUpInactiveTabs() });
}
