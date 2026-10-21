import { onAppEvent } from "@bay/shell";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { changedIds } from "../../store/changes";
import { cancelSwitcher, commitSwitcher, moveSwitcher } from "./switcher";
import { startCleanupNotifications } from "./cleanupNotifications";
import { showToast } from "../layout/splitActions";

let started = false;

export function startSidebarEffects() {
  if (started) return;
  started = true;
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
    if (e.type === "controlReleased" || e.type === "resignActive") commitSwitcher();
    if (e.type === "switcherMouseUp" || (e.type === "switcherKey" && e.key === "escape")) cancelSwitcher();
    if (e.type === "switcherKey" && e.key !== "escape") moveSwitcher(e.key === "next" ? 1 : -1);
  });
}
